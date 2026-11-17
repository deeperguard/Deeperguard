"""Browser test for "Manage templates" (design M3).

Loads the real template dialogs from app/templates/app.html, the real
app.css, dialog-a11y.js, templates.js and the real template section plus
confirmAction() from app.js into Chromium, backed by a small in-memory store.
Checks view, rename by keyboard, empty name refused, delete with confirm,
"Use" into the New-from-template dialog, Escape handling and focus, at phone
and desktop width in light and dark. Skips when Playwright/Chromium is missing.
"""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_HTML = (ROOT / "app/templates/app.html").read_text(encoding="utf-8")
APP_JS = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")
APP_CSS = ROOT / "app/static/css/app.css"
DIALOG_JS = ROOT / "app/static/js/dialog-a11y.js"
TEMPLATES_JS = ROOT / "app/static/js/templates.js"

sync_api = pytest.importorskip("playwright.sync_api")


def _between(text: str, start: str, end: str) -> str:
    i = text.index(start)
    return text[i:text.index(end, i)]


TEMPLATE_MARKUP = _between(APP_HTML, '<div id="template-dialog"', '<div id="quick-capture"').replace(
    "{% raw %}", "").replace("{% endraw %}", "")
CONFIRM_MARKUP = _between(APP_HTML, '<div id="confirm-dialog"', '<div id="ai-outbound-backdrop"')
BACKDROP_MARKUP = '<div id="confirm-backdrop" class="settings-backdrop" hidden></div>'
CONFIRM_SRC = "function confirmAction(" + APP_JS.split("function confirmAction(", 1)[1].split(
    "NotesStore.setCsrf(", 1)[0]
SECTION_SRC = _between(APP_JS, "  // --- Templates (design M3)", "  function createTag(title,")

PAGE = """<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8"></head>
<body><main><button id="opener" class="btn">Templates</button>
<button id="btn-new-from-template" class="btn">New from template</button></main>
{backdrop}{templates}{confirm}</body></html>"""

# In-memory stand-in for NotesStore with the methods templates.js uses.
STORE_JS = """
window.toasts = [];
const items = new Map();
let seq = 0;
window.NotesStore = {
  isUnlocked: () => true,
  newUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  defaultNote: () => ({ type: 'note', title: '', content: '', tags: [], folder_id: '', editor: 'plain' }),
  get: (id) => items.get(id),
  upsert(id, content) { items.set(id, { uuid: id, content: { ...content }, deleted: false }); },
  remove(id) { const it = items.get(id); if (!it) return false; it.deleted = true; return true; },
  listNotes: () => [...items.values()].filter((i) => i.content.type === 'note' && !i.deleted),
  listTemplateItems: () => [...items.values()].filter((i) => i.content.type === 'template' && !i.deleted),
};
window.items = items;
const tpl = (title, body) => ({ type: 'template', title, body, template_title: '{{title}}', tags: [], folder_id: '', editor: 'plain' });
NotesStore.upsert('00000000-0000-4000-8000-0000000000a1', tpl('Agenda', 'Agenda for {{date}}'));
NotesStore.upsert('00000000-0000-4000-8000-0000000000b2', tpl('Bug report', 'Steps:\\n1. '));
"""

STUBS_JS = """
var currentId = null, currentFilter = 'all';
function toast(msg, err) { window.toasts.push({ msg, err: !!err }); }
function flushSave() {}
function renderNotes() {}
function renderTags() {}
function setFilter(name) { currentFilter = name; }
function openNote(id) { window.openedNote = id; }
"""


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


def _open_page(browser, *, width, theme):
    ctx = browser.new_context(viewport={"width": width, "height": 800})
    page = ctx.new_page()
    page.set_content(PAGE.format(theme=theme, backdrop=BACKDROP_MARKUP, templates=TEMPLATE_MARKUP,
                                 confirm=CONFIRM_MARKUP))
    page.add_style_tag(path=str(APP_CSS))
    page.add_script_tag(path=str(DIALOG_JS))
    page.add_script_tag(path=str(TEMPLATES_JS))
    page.add_script_tag(content=STORE_JS)
    page.add_script_tag(content=STUBS_JS + CONFIRM_SRC + SECTION_SRC
                        + "\nwindow.openTemplateManager = openTemplateManager;")
    page.evaluate("document.getElementById('opener').addEventListener('click', () => openTemplateManager())")
    return ctx, page


def _names(page):
    return page.eval_on_selector_all("#template-manager-list .tpl-name", "els => els.map((e) => e.textContent)")


def _stored_title(page, uuid):
    return page.evaluate(f"items.get('{uuid}').content.title")


def _focused(page):
    return page.evaluate("""() => {
      const el = document.activeElement;
      return { action: el.dataset.tplAction || '', name: el.name || '', id: el.id || '',
               row: el.closest('[data-tpl-id]')?.dataset.tplId || '' };
    }""")


A, B = "00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b2"


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_manage_templates_view_rename_delete(browser, tmp_path, width, theme):
    ctx, page = _open_page(browser, width=width, theme=theme)
    try:
        page.focus("#opener")
        page.keyboard.press("Enter")
        page.wait_for_selector("#template-manager:not([hidden])")
        assert _names(page) == ["Agenda", "Bug report"]
        assert "Agenda for {{date}}" in page.inner_text("#template-manager-list"), "text preview shown"
        # Usable at this width: the card fits, no horizontal scrolling.
        card = page.locator("#template-manager .template-dialog-card").bounding_box()
        assert card["x"] >= 0 and card["x"] + card["width"] <= width + 0.5
        assert page.evaluate("(() => { const c = document.querySelector('#template-manager .template-dialog-card');"
                             " return c.scrollWidth <= c.clientWidth; })()")
        colors = page.evaluate("""() => { const s = getComputedStyle(document.querySelector('#template-manager .tpl-name'));
          const c = getComputedStyle(document.querySelector('#template-manager .template-dialog-card'));
          return [s.color, c.backgroundColor]; }""")
        assert colors[0] != colors[1]
        # Focus starts on the first row; the buttons name the template they act on.
        assert _focused(page) == {"action": "use", "name": "", "id": "", "row": A}
        described = page.get_attribute(f'[data-tpl-id="{A}"] [data-tpl-action="edit"]', "aria-describedby")
        assert page.inner_text(f"#{described}") == "Agenda"

        # Rename by keyboard: Tab to Rename, Enter, type, Enter.
        page.keyboard.press("Tab")
        assert _focused(page)["action"] == "edit"
        outline = page.evaluate("() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth]; }")
        assert outline[0] != "none" and outline[1] != "0px", "visible focus"
        page.keyboard.press("Enter")
        assert _focused(page) == {"action": "", "name": "name", "id": "", "row": A}
        page.keyboard.press("Control+A")
        page.keyboard.type("Weekly agenda")
        page.keyboard.press("Enter")
        assert _stored_title(page, A) == "Weekly agenda"
        assert page.evaluate(f"items.get('{A}').content.body") == "Agenda for {{date}}", "text unchanged"
        assert _names(page) == ["Bug report", "Weekly agenda"], "list re-sorted under the new name"
        assert _focused(page) == {"action": "edit", "name": "", "id": "", "row": A}, "focus back on Rename"

        # Empty name is refused with a visible message; Escape cancels the edit.
        page.keyboard.press("Enter")
        page.keyboard.press("Control+A")
        page.keyboard.press("Delete")
        page.keyboard.press("Enter")
        assert page.inner_text(f'[data-tpl-id="{A}"] .tpl-manage-error') == "Give the template a name."
        assert _stored_title(page, A) == "Weekly agenda"
        page.keyboard.press("Escape")
        assert page.is_visible("#template-manager"), "first Escape only leaves the edit form"
        assert _focused(page)["action"] == "edit"
        page.screenshot(path=str(tmp_path / f"templates-{width}-{theme}.png"))

        # Delete asks first; cancel keeps it, confirm deletes it.
        page.click(f'[data-tpl-id="{B}"] [data-tpl-action="delete"]')
        page.wait_for_selector("#confirm-dialog:not([hidden])")
        assert "Bug report" in page.inner_text("#confirm-dialog")
        page.click("#confirm-cancel")
        page.wait_for_selector("#confirm-dialog", state="hidden")
        assert page.evaluate(f"items.get('{B}').deleted") is False
        page.click(f'[data-tpl-id="{B}"] [data-tpl-action="delete"]')
        page.wait_for_selector("#confirm-dialog:not([hidden])")
        page.click("#confirm-ok")
        page.wait_for_function("document.querySelectorAll('#template-manager-list .tpl-manage-row').length === 1")
        assert page.evaluate(f"items.get('{B}').deleted") is True
        assert _names(page) == ["Weekly agenda"]
        assert page.evaluate("toasts.at(-1).msg") == "Template deleted"

        # Escape closes the manager and focus returns to the opener.
        page.focus(f'[data-tpl-id="{A}"] [data-tpl-action="use"]')
        page.keyboard.press("Escape")
        page.wait_for_selector("#template-manager", state="hidden")
        assert page.inner_html("#template-manager-list") == "", "no template names left in the closed dialog"
        assert _focused(page)["id"] == "opener"
    finally:
        ctx.close()


def test_use_opens_new_from_template_with_that_template(browser):
    ctx, page = _open_page(browser, width=390, theme="light")
    try:
        page.click("#opener")
        page.click(f'[data-tpl-id="{B}"] [data-tpl-action="use"]')
        page.wait_for_selector("#template-manager", state="hidden")
        page.wait_for_selector("#template-dialog:not([hidden])")
        assert page.inner_text("#template-dialog-list .tpl-option.active .tpl-name") == "Bug report"
        page.fill("#template-dialog-name", "Login fails")
        page.click("#template-dialog-create")
        made = page.evaluate("items.get(window.openedNote).content")
        assert made["type"] == "note" and made["title"] == "Login fails"
        assert made["content"] == "Steps:\n1. "
    finally:
        ctx.close()


def test_last_template_deleted_shows_empty_state(browser):
    ctx, page = _open_page(browser, width=1280, theme="dark")
    try:
        page.evaluate(f"NotesStore.remove('{A}')")
        page.click("#opener")
        page.click(f'[data-tpl-id="{B}"] [data-tpl-action="delete"]')
        page.click("#confirm-ok")
        page.wait_for_selector("#template-manager-list .tpl-hint")
        assert "No templates yet" in page.inner_text("#template-manager-list")
        assert _focused(page)["id"] == "template-manager-close", "focus lands on Close"
    finally:
        ctx.close()
