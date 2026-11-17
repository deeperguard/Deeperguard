"""E2E: footer meta, reading width and collapsible list column at 1920px.

Behaviour tests for docs/UI_POLISH.md section 7 (idea #138):
  - an attachment/PDF note never shows "0 words" in #note-meta but keeps
    "Scanned text: N words"; a plain note shows its word count;
  - text content is capped at --content-max on a 1920px viewport;
  - "Linked from" is compact when empty;
  - #btn-list-toggle collapses/expands the list column (class, aria-expanded),
    persists in localStorage 'deeperguard-prefs' only, and is stored under listCollapsed.

    python tests/e2e_layout_footer_width.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import sync_playwright  # noqa: E402

import e2e_layout_actions as base  # noqa: E402

base.WIDTH, base.HEIGHT = 1920, 1080


def meta_text(page) -> str:
    return page.evaluate("() => document.getElementById('note-meta').innerText")


def main() -> int:
    proc, url = base.run_server()
    try:
        with sync_playwright() as pw:
            browser, page, _ids = base.boot(pw, url)

            base.open_note(page, "Layout plain note")
            text = meta_text(page)
            assert "word" in text and "Scanned text" not in text, text

            content_max = page.evaluate(
                "() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-max'))"
            )
            foot_w = page.evaluate("() => document.querySelector('.editor-foot').getBoundingClientRect().width")
            pane_w = page.evaluate("() => document.getElementById('editor-pane').getBoundingClientRect().width")
            assert content_max == 860, content_max
            assert pane_w > content_max + 100, pane_w
            assert abs(foot_w - content_max) <= 1, (foot_w, content_max)

            bl = page.evaluate(
                """() => {
                  const el = document.getElementById('backlinks');
                  const e = el.querySelector('.backlinks-empty');
                  return { empty: el.dataset.empty, sentenceShown: !!e && e.getClientRects().length > 0 };
                }"""
            )
            assert bl["empty"] == "true" and not bl["sentenceShown"], bl

            base.open_note(page, "Layout PDF note")
            text = meta_text(page)
            assert "0 words" not in text, text
            assert "Scanned text:" in text and "words" in text, text

            viewer = page.evaluate(
                """() => {
                  const r = (sel) => {
                    const el = document.querySelector(sel);
                    return el ? el.getBoundingClientRect().width : null;
                  };
                  return {
                    active: !!document.querySelector('.editor.doc-preview-active'),
                    inline: r('.editor.doc-preview-active .doc-inline'),
                    card: r('.editor.doc-preview-active .doc-inline-card'),
                    foot: r('.editor.doc-preview-active .editor-foot'),
                    max: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-max-viewer')),
                  };
                }"""
            )
            assert viewer["active"], viewer
            assert viewer["inline"] > content_max, viewer
            assert viewer["inline"] > viewer["max"], viewer
            assert viewer["foot"] <= viewer["max"] + 1, viewer

            toggle = page.locator("#btn-list-toggle")
            assert toggle.get_attribute("aria-expanded") == "true"
            toggle.click()
            page.wait_for_function("() => document.documentElement.classList.contains('list-collapsed')")
            assert toggle.get_attribute("aria-expanded") == "false"
            assert not page.locator("#note-list").is_visible()
            prefs = json.loads(page.evaluate("() => localStorage.getItem('deeperguard-prefs')"))
            assert prefs.get("listCollapsed") is True, prefs

            page.reload()
            page.wait_for_function(
                "() => document.body.classList.contains('unlocked') || document.getElementById('unlock-password')",
                timeout=30000,
            )
            if page.locator("#unlock-password").count() and not page.evaluate(base.UNLOCKED_JS):
                page.fill("#unlock-password", base.PASSWORD)
                page.click("#unlock-submit")
            page.wait_for_function(base.UNLOCKED_JS, timeout=60000)
            page.wait_for_function("() => document.documentElement.classList.contains('list-collapsed')")
            assert page.locator("#btn-list-toggle").get_attribute("aria-expanded") == "false"
            assert not page.locator("#note-list").is_visible()

            page.locator("#btn-list-toggle").click()
            page.wait_for_function("() => !document.documentElement.classList.contains('list-collapsed')")
            assert page.locator("#btn-list-toggle").get_attribute("aria-expanded") == "true"
            prefs = json.loads(page.evaluate("() => localStorage.getItem('deeperguard-prefs')"))
            assert prefs.get("listCollapsed") is False, prefs
            assert page.locator("#note-list").is_visible()

            splitter = page.locator("#pane-splitter")
            before = int(splitter.get_attribute("aria-valuenow"))
            splitter.focus()
            page.keyboard.press("ArrowRight")
            after = int(splitter.get_attribute("aria-valuenow"))
            assert after > before, (before, after)
            browser.close()
    finally:
        base.stop_server(proc)
    print("ok e2e layout footer/width")
    return 0


if __name__ == "__main__":
    sys.exit(main())
