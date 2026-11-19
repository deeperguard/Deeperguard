"""Label tree integrity: model tests in Node, plus the message a refused move shows.

The browser part loads the real labels.js and the real moveLabel() from app.js
into Chromium, backed by a small in-memory store that plans moves with the real
NotesLabels.planUpdate. Skips the browser part when Playwright/Chromium is missing.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")
LABELS_JS = ROOT / "app/static/js/labels.js"

MOVE_SRC = "function moveLabel(" + APP_JS.split("function moveLabel(", 1)[1].split(
    "function openLabelMenu(", 1)[0]

STORE_JS = """
window.toasts = [];
window.renders = 0;
const tags = new Map();
const tag = (name, parent) => ({ type: 'tag', title: name, name, parent_id: parent, title_sync: name, order: 1024 });
tags.set('work', tag('Work', ''));
tags.set('proj', tag('Projects', 'work'));
tags.set('alpha', tag('Alpha', 'proj'));
tags.set('solo', tag('Solo', ''));
window.tags = tags;
window.NotesStore = {
  get: (id) => (tags.has(id) ? { uuid: id, content: tags.get(id) } : undefined),
  moveTagResult(uuid, parentId) {
    const plan = NotesLabels.planUpdate(uuid, { parent_id: parentId || '' }, tags);
    if (!plan.ok) return { ok: false, error: plan.error };
    plan.updates.forEach((u) => tags.set(u.uuid, u.content));
    return { ok: true };
  },
};
var currentId = null;
function toast(msg, err) { window.toasts.push({ msg, err: !!err }); }
function setLabelOpen() {}
function invalidateTagMap() {}
function renderTags() { window.renders += 1; }
function renderNotes() {}
function renderTagBar() {}
function focusLabel() {}
"""


def test_label_tree_model_in_node():
    proc = subprocess.run(
        ["node", str(ROOT / "tests" / "test_label_tree_integrity.js")],
        cwd=str(ROOT), capture_output=True, text=True, timeout=120, check=False,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "test_label_tree_integrity.js: ok" in proc.stdout


@pytest.fixture(scope="module")
def page():
    sync_api = pytest.importorskip("playwright.sync_api")
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:  # Chromium not installed
                pytest.skip(f"Chromium not available: {exc}")
            pg = browser.new_page()
            pg.set_content("<!doctype html><html><body></body></html>")
            pg.add_script_tag(path=str(LABELS_JS))
            pg.add_script_tag(content=STORE_JS + MOVE_SRC + "\nwindow.moveLabel = moveLabel;")
            yield pg
            browser.close()
    except Exception as exc:
        if isinstance(exc, pytest.skip.Exception):
            raise
        pytest.skip(f"Playwright not usable: {exc}")


def _move(page, uuid, parent):
    return page.evaluate(
        """([uuid, parent]) => {
            window.toasts.length = 0;
            const ok = moveLabel(uuid, parent);
            return { ok, toasts: window.toasts.slice(), parent: window.tags.get(uuid)?.parent_id, renders: window.renders };
        }""",
        [uuid, parent],
    )


def test_move_under_own_sub_label_is_refused_with_its_reason(page):
    for target in ("alpha", "proj", "work"):
        for _ in range(2):  # the same refused move twice gives the same answer
            got = _move(page, "work", target)
            assert got["ok"] is False
            assert got["toasts"] == [{
                "msg": "A label cannot be moved into itself or one of its own sub-labels.",
                "err": True,
            }]
            assert got["parent"] == ""
            assert got["renders"] == 0


def test_other_refusals_name_their_own_reason(page):
    gone = _move(page, "solo", "no-such-label")
    assert gone["ok"] is False
    assert gone["toasts"] == [{"msg": "The target label no longer exists.", "err": True}]
    page.evaluate("window.tags.set('twin', { type: 'tag', title: 'Solo', name: 'Solo', parent_id: 'work', order: 2048 })")
    twin = _move(page, "solo", "work")
    assert twin["toasts"] == [{"msg": "A label with this name already exists there.", "err": True}]
    assert twin["parent"] == ""


def test_valid_move_still_works(page):
    got = _move(page, "alpha", "work")
    assert got["ok"] is True
    assert got["toasts"] == [{"msg": "Label moved", "err": False}]
    assert got["parent"] == "work"
    assert got["renders"] == 1
