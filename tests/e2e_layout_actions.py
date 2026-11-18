"""E2E: every existing shell action stays present, named and reachable.

Guards the layout restructure (idea #105, docs/UI_POLISH.md section 7). A
throwaway account with synthetic data opens Notes (a plain note and a PDF
note), Agenda and 2FA at desktop width. For every row of the control table in
section 7.2 (read into ACTIONS below) the control must exist, have an
accessible name and be reachable: visible, or visible after opening the listed
visible menu/disclosure. Note-type specific actions are only checked on the
note type they apply to. A second account repeats the row check at 390x844
against the Phone reach column, on the plain note and the PDF note (each
opened by tapping its row in the list), Agenda and 2FA.

Two kinds of row are checked by what they do, not only by being there:
  - the six quick-row buttons of the note info panel are phone-only. On
    desktop each action (star, pin, copy, archive, duplicate, trash) is clicked
    through the control the table names and its effect on the note is checked;
    at phone width the quick row itself is opened and clicked the same way;
  - `.note-row-delete` is checked per row kind (normal, trashed, locked).

The note header and toolbar (section 7.5) are measured on both note types: the
title on its own line, folder and tags on one compact row, toolbar buttons of
one size with a tooltip and an aria-label in tab order, and controls of the
other note type hidden (the format select on a PDF note) while they keep
working where they apply.

    python tests/e2e_layout_actions.py
"""
from __future__ import annotations

import base64
import re
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

WIDTH, HEIGHT = 1440, 900

UNLOCKED_JS = """() => location.pathname === '/app'
  && window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked')"""


def make_pdf(text: str = "Synthetic layout test invoice 12345") -> bytes:
    """A one-page PDF with a real text layer (no external libraries)."""
    stream = f"BT /F1 18 Tf 1 0 0 1 72 760 Tm ({text}) Tj ET".encode("latin-1")
    objects = [
        b"<</Type /Catalog /Pages 2 0 R>>",
        b"<</Type /Pages /Kids [3 0 R] /Count 1>>",
        b"<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>",
        b"<</Length " + str(len(stream)).encode() + b">>\nstream\n" + stream + b"\nendstream",
        b"<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<</Size {len(objects) + 1} /Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


SEED_JS = """async (pdfB64) => {
  const plain = NotesStore.newUuid();
  NotesStore.upsert(plain, { ...NotesStore.defaultNote(), title: 'Layout plain note',
    content: 'Synthetic body text for the layout test.', attachments: [] });
  const pdf = NotesStore.newUuid();
  NotesStore.upsert(pdf, { ...NotesStore.defaultNote(), title: 'Layout PDF note', content: '', attachments: [] });
  const raw = atob(pdfB64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  const file = new File([bytes], 'layout-test.pdf', { type: 'application/pdf' });
  const attId = await NotesStore.addAttachment(pdf, file, { displayName: 'layout-test.pdf' });
  NotesStore.setAttachmentOcr(attId, 'Synthetic layout test invoice 12345', 'client', []);
  NotesStore.refreshNoteSearchText(pdf);
  return { plain, pdf, attId };
}"""

DISMISS_JS = """() => {
  document.querySelectorAll('button').forEach((btn) => {
    const label = (btn.textContent || '').trim();
    if (label === 'Not now' && btn.getClientRects().length > 0) btn.click();
  });
}"""


def register(page, base: str) -> None:
    email = f"layout-{int(time.time())}@home.local"
    page.goto(f"{base}/register", wait_until="domcontentloaded")
    page.wait_for_selector("#register-form")
    page.fill('input[name="email"]', email)
    page.fill("#register-password", PASSWORD)
    page.fill("#register-password2", PASSWORD)
    page.check("#register-terms")
    page.check("#register-recover-ack")
    page.evaluate(
        """() => {
          document.querySelectorAll('.cf-turnstile').forEach((el) => el.remove());
          let input = document.querySelector('input[name="cf-turnstile-response"]');
          if (!input) {
            input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'cf-turnstile-response';
            document.getElementById('register-form').appendChild(input);
          }
          input.value = 'e2e-dummy-turnstile-token';
        }"""
    )
    page.click("#register-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120000)
    complete_recovery_key_step(page)


def open_note(page, title: str) -> None:
    page.click("#app-tab-notes", timeout=10000)
    page.locator(".note-item", has_text=title).first.click(timeout=10000)
    page.wait_for_function(
        "(t) => document.getElementById('note-title')?.value === t", arg=title, timeout=10000
    )
    page.wait_for_timeout(600)


def boot(playwright, base: str):
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": WIDTH, "height": HEIGHT}).new_page()
    register(page, base)
    page.evaluate(DISMISS_JS)
    ids = page.evaluate(SEED_JS, base64.b64encode(make_pdf()).decode("ascii"))
    return browser, page, ids


def run_server():
    root = Path(tempfile.mkdtemp(prefix="e2e-layout-actions-"))
    port = free_port()
    proc = start_server(root, port, extra_env={"NOTES_DEFAULT_PLAN": "pro"})
    return proc, f"http://127.0.0.1:{port}"


def stop_server(proc) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except Exception:
        proc.kill()


# --------------------------------------------------------------------------
# The control table (docs/UI_POLISH.md section 7.2) is the single source.
# --------------------------------------------------------------------------

DOC = Path(__file__).resolve().parents[1] / "docs" / "UI_POLISH.md"
PHONE_WIDTH, PHONE_HEIGHT = 390, 844
PLAIN_TITLE, PDF_TITLE = "Layout plain note", "Layout PDF note"

# The six phone-only quick-row buttons of the note info panel and what each
# one must do. `flag` is the note content field the action flips.
QUICK_ROW = {
    "#note-info-star": {"action": "star", "flag": "starred"},
    "#note-info-pin": {"action": "pin", "flag": "pinned"},
    "#note-info-share": {"action": "copy", "flag": None},
    "#note-info-archive": {"action": "archive", "flag": "archived"},
    "#note-info-duplicate": {"action": "duplicate", "flag": None},
    "#note-info-trash": {"action": "trash", "flag": "trashed"},
}
ROW_KINDS = ("normal", "trashed", "locked")


def _ticks(text: str) -> list[str]:
    return re.findall(r"`([^`]+)`", text)


def parse_reach(reach: str) -> dict:
    """Reach column grammar, see the legend above the table in section 7.2."""
    if reach == "visible":
        return {"kind": "visible", "via": []}
    if reach.startswith("via "):
        return {"kind": "via", "via": _ticks(reach)}
    if reach.startswith("conditional"):
        return {"kind": "conditional"}
    if reach.startswith("replaced by "):
        *openers, control = _ticks(reach.split("(")[0])
        return {"kind": "replaced", "via": openers, "control": control}
    if reach.startswith("phone-only:"):
        out = {"kind": "phone-only", "phone_via": None, "desktop": None, "desktop_via": []}
        for clause in reach[len("phone-only:"):].split(";"):
            clause = clause.strip()
            if clause.startswith("phone via "):
                out["phone_via"] = _ticks(clause)
            elif clause.startswith("desktop action "):
                ticks = _ticks(clause)
                out["desktop_via"], out["desktop"] = ticks[:-1], ticks[-1]
        if not out["phone_via"] or not out["desktop"]:
            raise ValueError(f"phone-only reach needs 'phone via' and 'desktop action': {reach}")
        return out
    if reach.startswith("by row kind:"):
        kinds = {}
        for clause in reach[len("by row kind:"):].split(";"):
            name, _, rest = clause.strip().partition(" ")
            if rest.startswith("visible"):
                kinds[name] = {"shown": True, "via": []}
            elif rest.startswith("hidden"):
                kinds[name] = {"shown": False, "via": _ticks(rest)}
            else:
                raise ValueError(f"row kind clause must start with visible/hidden: {clause}")
        if sorted(kinds) != sorted(ROW_KINDS):
            raise ValueError(f"row kinds must be exactly {ROW_KINDS}: {reach}")
        return {"kind": "row-kind", "kinds": kinds}
    raise ValueError(f"unknown reach: {reach}")


def load_actions() -> list[dict]:
    text = DOC.read_text(encoding="utf-8")
    block = text.split("<!-- layout-actions:start -->")[1].split("<!-- layout-actions:end -->")[0]
    rows = []
    for line in block.splitlines():
        if not line.startswith("| `"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 7:
            raise ValueError(f"table row needs 7 cells: {line}")
        selector, name, _old, _new, applies, reach, phone_reach = cells
        if not phone_reach:
            raise ValueError(f"Phone reach is empty for {selector}")
        rows.append({"selector": selector.strip("`"), "name": name, "applies": applies,
                     "reach": reach, **parse_reach(reach),
                     "phone_reach": {"text": phone_reach, **parse_reach(phone_reach)}})
    return rows


ACTIONS = load_actions()

# Present in the DOM, shown, and what a screen reader would call it.
PROBE_JS = r"""(sel) => {
  const all = Array.from(document.querySelectorAll(sel));
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    if (getComputedStyle(el).visibility !== 'visible') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const el = all.find(shown) || all[0];
  if (!el) return { present: false };
  const text = (n) => ((n && (n.innerText || n.textContent)) || '').replace(/\s+/g, ' ').trim();
  let name = (el.getAttribute('aria-label') || '').trim();
  if (!name && el.getAttribute('aria-labelledby')) {
    name = el.getAttribute('aria-labelledby').split(/\s+/)
      .map((id) => text(document.getElementById(id))).join(' ').trim();
  }
  if (!name && el.labels && el.labels.length) name = text(el.labels[0]);
  if (!name) name = text(el);
  if (!name) name = (el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
  let opacity = 1;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
  return { present: true, visible: shown(el), name, opacity, count: all.length };
}"""

NOTE_STATE_JS = """(title) => {
  const same = NotesStore.listNotes().filter((n) => !n.deleted && (n.content.title || '').includes(title));
  const n = same.find((x) => (x.content.title || '') === title);
  return { count: same.length, starred: !!n?.content.starred, pinned: !!n?.content.pinned,
    archived: !!n?.content.archived, trashed: !!n?.content.trashed };
}"""

SEED_NOTE_JS = """([title, extra]) => {
  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title,
    content: 'Synthetic body text for the layout test.', attachments: [], ...extra });
  return id;
}"""

CLIPBOARD_SPY_JS = """() => {
  window.__copied = null;
  navigator.clipboard.writeText = async (t) => { window.__copied = String(t); };
}"""

ROW_JS = """(title) => {
  document.querySelectorAll('[data-layout-probe]').forEach((r) => r.removeAttribute('data-layout-probe'));
  const row = Array.from(document.querySelectorAll('.note-row'))
    .find((r) => (r.querySelector('.note-item')?.innerText || '').includes(title));
  if (!row) return null;
  row.dataset.layoutProbe = '1';
  const del = row.querySelector('.note-row-delete');
  return { hasDelete: !!del, inMenu: !!del && del.hasAttribute('data-in-menu'),
    hasMore: !!row.querySelector('.note-row-more'), name: del ? del.getAttribute('aria-label') : '' };
}"""


class Report:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.checked = 0

    def check(self, label: str, cond, detail="") -> bool:
        self.checked += 1
        if not cond:
            self.failures.append(f"{label} {detail}".rstrip())
            print(f"FAIL {label} {detail}".rstrip(), flush=True)
        return bool(cond)


def probe(page, selector: str) -> dict:
    return page.evaluate(PROBE_JS, selector)


def first_line(err: Exception) -> str:
    return (str(err).splitlines() or [repr(err)])[0]


def click_visible(page, selector: str) -> None:
    page.locator(selector).locator("visible=true").first.click(timeout=5000)
    page.wait_for_timeout(350)


CLOSERS = (
    "#doc-close", "#doc-immersive-close", "#note-options-close",
    "#search-filter-close", "#find-close", "#agenda-calendar-settings-close",
    "#note-row-menu-backdrop",
    '#btn-editor-overflow-desktop[aria-expanded="true"]', '#btn-editor-overflow-mobile[aria-expanded="true"]',
    '#tag-bar-toggle[aria-expanded="true"]', '#btn-nav-pin[aria-expanded="true"]',
)


def escape_all(page) -> None:
    """Close whatever an earlier check left open, through its own visible close control."""
    for selector in ("#agenda-phone-menu-backdrop", "#editor-toolbar-menu-backdrop"):
        backdrop = page.locator(selector).locator("visible=true")
        if backdrop.count():
            # The menu panel covers the backdrop centre: click its bottom-left corner.
            size = page.viewport_size
            backdrop.first.click(position={"x": 5, "y": size["height"] - 5}, timeout=3000)
            page.wait_for_timeout(250)
    for selector in CLOSERS:
        loc = page.locator(selector).locator("visible=true")
        if loc.count():
            try:
                loc.first.click(timeout=3000)
            except Exception:  # noqa: BLE001 - the next check reports a real problem
                pass
            page.wait_for_timeout(250)


def reset_notes(page) -> None:
    """Notes screen, 'all' view, nothing open on top."""
    escape_all(page)
    page.click("#app-tab-notes", timeout=10000)
    show_view(page, "all")


def show_view(page, view: str) -> None:
    """Pick a sidebar view and wait until the list column has stopped moving."""
    if not page.locator(f'.filter.active[data-filter="{view}"]').count():
        page.click(f'.filter[data-filter="{view}"]', timeout=10000)
    page.mouse.move(WIDTH - 200, HEIGHT - 80)
    page.wait_for_timeout(400)
    page.wait_for_function(
        """() => new Promise((resolve) => {
          const left = () => document.getElementById('note-list')?.getBoundingClientRect().left;
          const first = left();
          setTimeout(() => resolve(left() === first), 300);
        })""",
        timeout=10000,
    )


def open_fresh(page, title: str) -> None:
    """Re-open a seeded note from a clean state (closes menus, panels, edit view)."""
    reset_notes(page)
    open_note(page, PDF_TITLE if title == PLAIN_TITLE else PLAIN_TITLE)
    open_note(page, title)


def check_rows(page, report: Report, where: str, rows: list[dict], reset, reach: str = "reach") -> None:
    """Rows of one screen: present, named and reachable the way the table says.

    `reach` names the table column used: "reach" (desktop) or "phone_reach" (390px).
    """
    def spec(row: dict) -> dict:
        return row if reach == "reach" else row[reach]

    def label_of(row: dict) -> str:
        return f"[{where}] {row['selector']} ({row['reach'] if reach == 'reach' else row[reach]['text']})"

    def target(row: dict) -> str:
        return spec(row).get("control", row["selector"])

    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        if spec(row)["kind"] in ("visible", "via", "replaced"):
            groups.setdefault(tuple(spec(row)["via"]), []).append(row)
    for via, group in groups.items():
        reset()
        opened = True
        for opener in via:
            try:
                click_visible(page, opener)
            except Exception as err:  # noqa: BLE001 - reported as a failure
                opened = False
                for row in group:
                    report.check(label_of(row), False, f"opener {opener} not clickable: {first_line(err)}")
                break
        if not opened:
            continue
        for row in group:
            info = probe(page, target(row))
            label = label_of(row)
            if not report.check(label + " present", info["present"]):
                continue
            report.check(label + " reachable", info["visible"], info)
            report.check(label + " has an accessible name", bool(info["name"]), info)
    reset()
    for row in rows:
        if spec(row)["kind"] not in ("conditional", "replaced"):
            continue
        info = probe(page, row["selector"])
        label = label_of(row)
        if report.check(label + " present", info["present"]):
            report.check(label + " has an accessible name", bool(info["name"]), info)


# --------------------------------------------------------------------------
# Note header and toolbar (docs/UI_POLISH.md section 7.5).
# --------------------------------------------------------------------------

TOOLBAR_SIZE = 36
# The toolbar buttons in the order of section 7.5; the note type select sits
# between the lock button and Find where it applies.
TOOLBAR_BUTTONS = [
    "#btn-prevent-edit", "#btn-find-desktop", "#btn-ai-chat",
    '[data-editor-proxy="btn-star"].editor-desktop-star', "#btn-download-note", "#btn-editor-overflow-desktop",
]
TAB_ORDER = {
    "plain": ["note-title", "note-folder-select", "btn-move-note", "tag-bar-toggle", "btn-prevent-edit",
              "note-editor-type", "btn-find-desktop", "btn-ai-chat", "star", "btn-download-note",
              "btn-editor-overflow-desktop"],
    "pdf": ["note-title", "note-folder-select", "btn-move-note", "tag-bar-toggle", "btn-prevent-edit",
            "btn-find-desktop", "btn-ai-chat", "star", "btn-download-note", "btn-editor-overflow-desktop"],
}
# Controls that do not apply to a note type must not be shown for it, neither
# in the toolbar row nor in its "…" menu.
HIDDEN_FOR = {
    "plain": ["#btn-preview", "#btn-ocr-text", "#btn-rescan-ocr", "#btn-desktop-doc-fullscreen"],
    "pdf": ["#note-editor-type", "#btn-undo", "#btn-redo", "#md-toolbar"],
}

BOX_JS = """(sel) => {
  const el = Array.from(document.querySelectorAll(sel)).find((x) => x.getClientRects().length);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
    title: (el.getAttribute('title') || '').trim(), label: (el.getAttribute('aria-label') || '').trim(),
    text: (el.innerText || '').replace(/\\s+/g, ' ').trim(), radius: getComputedStyle(el).borderTopLeftRadius };
}"""

FOCUS_JS = """() => {
  const el = document.activeElement;
  return el ? (el.id || (el.matches('[data-editor-proxy="btn-star"]') ? 'star' : el.tagName)) : '';
}"""

NOTE_EDITOR_JS = """(title) => NotesStore.listNotes()
  .find((n) => !n.deleted && n.content.title === title)?.content.editor || 'plain'"""

CLEAR_TAGS_JS = """(title) => {
  const note = NotesStore.listNotes().find((n) => !n.deleted && n.content.title === title);
  NotesStore.upsert(note.uuid, { ...note.content, tags: [] });
}"""


def check_header_layout(page, report: Report, where: str, title: str) -> None:
    """Title on its own line; folder and tags on one compact row under it."""
    open_fresh(page, title)
    head, folder, tags = (page.evaluate(BOX_JS, sel) for sel in ("#note-title", "#note-folder-select", "#tag-bar-toggle"))
    lock = page.evaluate(BOX_JS, "#btn-prevent-edit")
    if not report.check(f"[{where}] title, folder and tags are shown", bool(head and folder and tags and lock)):
        return
    report.check(f"[{where}] nothing shares the title line",
                 folder["top"] >= head["bottom"] and tags["top"] >= head["bottom"], [head, folder, tags])
    report.check(f"[{where}] folder and tags share one row of the same height",
                 abs(folder["top"] - tags["top"]) <= 1 and folder["height"] == tags["height"] == 32, [folder, tags])
    report.check(f"[{where}] folder comes first and is at most 220px wide",
                 folder["right"] <= tags["left"] and folder["width"] <= 220, [folder, tags])
    report.check(f"[{where}] the toolbar sits under the meta row", lock["top"] >= folder["bottom"], [folder, lock])
    report.check(f"[{where}] a note without tags offers 'Add tag' instead of 'None'",
                 "Add tag" in tags["text"] and "None" not in tags["text"], tags)


def check_toolbar_buttons(page, report: Report, where: str, title: str, scope: str) -> None:
    """Equal-size buttons, each with a tooltip and an aria-label, in a logical tab order."""
    open_fresh(page, title)
    boxes = []
    for selector in TOOLBAR_BUTTONS:
        box = page.evaluate(BOX_JS, selector)
        if not report.check(f"[{where}] toolbar {selector} is shown", bool(box)):
            continue
        boxes.append(box)
        report.check(f"[{where}] toolbar {selector} is {TOOLBAR_SIZE}x{TOOLBAR_SIZE}px",
                     box["width"] == TOOLBAR_SIZE and box["height"] == TOOLBAR_SIZE, box)
        report.check(f"[{where}] toolbar {selector} has a tooltip", bool(box["title"]), box)
        report.check(f"[{where}] toolbar {selector} has an aria-label", bool(box["label"]), box)
    report.check(f"[{where}] toolbar buttons share one row, radius and left-to-right order",
                 len({(b["top"], b["radius"]) for b in boxes}) == 1
                 and [b["left"] for b in boxes] == sorted(b["left"] for b in boxes), boxes)
    page.focus("#note-title")
    seen = [page.evaluate(FOCUS_JS)]
    for _ in TAB_ORDER[scope][1:]:
        page.keyboard.press("Tab")
        seen.append(page.evaluate(FOCUS_JS))
    report.check(f"[{where}] Tab walks title, folder, tags and then the toolbar in order", seen == TAB_ORDER[scope], seen)


def check_type_specific(page, report: Report, where: str, title: str, scope: str) -> None:
    """Controls of the other note type are hidden, not shown idle."""
    open_fresh(page, title)
    for selector in HIDDEN_FOR[scope]:
        report.check(f"[{where}] {selector} is not in the toolbar", not probe(page, selector).get("visible"))
    click_visible(page, "#btn-editor-overflow-desktop")
    for selector in HIDDEN_FOR[scope]:
        report.check(f"[{where}] {selector} is not in the '…' menu", not probe(page, selector).get("visible"))
    escape_all(page)


def check_note_type_select(page, report: Report) -> None:
    """The format select still works on a plain note and comes back when a PDF note's text is edited."""
    open_fresh(page, PLAIN_TITLE)
    box = page.evaluate(BOX_JS, "#note-editor-type")
    if report.check("[plain note] #note-editor-type is shown, named and as high as the buttons",
                    bool(box) and bool(box["label"]) and box["height"] == TOOLBAR_SIZE, box):
        page.select_option("#note-editor-type", "checklist")
        page.wait_for_timeout(500)
        report.check("[plain note] choosing Checklist changes the note's format",
                     page.evaluate(NOTE_EDITOR_JS, PLAIN_TITLE) == "checklist" and probe(page, "#checklist").get("visible"))
        page.select_option("#note-editor-type", "plain")
        page.wait_for_timeout(500)
        report.check("[plain note] choosing Plain text changes it back",
                     page.evaluate(NOTE_EDITOR_JS, PLAIN_TITLE) == "plain" and probe(page, "#note-body").get("visible"))

    open_fresh(page, PDF_TITLE)
    report.check("[PDF note] #note-editor-type is hidden in the document view",
                 not probe(page, "#note-editor-type").get("visible"))
    click_visible(page, "#btn-editor-overflow-desktop")
    click_visible(page, "#btn-preview")
    report.check("[PDF note] #note-editor-type returns when the note text is edited",
                 probe(page, "#note-editor-type").get("visible") and probe(page, "#note-body").get("visible"))
    click_visible(page, "#btn-editor-overflow-desktop")
    click_visible(page, "#btn-preview")
    report.check("[PDF note] #note-editor-type is hidden again back in the document view",
                 not probe(page, "#note-editor-type").get("visible"))


def check_tag_summary(page, report: Report) -> None:
    """One tag: the meta row names it. No tag again: back to 'Add tag'."""
    open_fresh(page, PLAIN_TITLE)
    click_visible(page, "#tag-bar-toggle")
    page.fill("#tag-bar-input", "layout-tag")
    click_visible(page, "#tag-bar-add")
    open_fresh(page, PLAIN_TITLE)
    text = (page.evaluate(BOX_JS, "#tag-bar-toggle") or {}).get("text", "")
    report.check("[plain note] a tagged note shows 'Tags' and the tag name", "Tags" in text and "layout-tag" in text
                 and "Add tag" not in text, text)
    page.evaluate(CLEAR_TAGS_JS, PLAIN_TITLE)
    open_fresh(page, PLAIN_TITLE)
    text = (page.evaluate(BOX_JS, "#tag-bar-toggle") or {}).get("text", "")
    report.check("[plain note] with the tag removed it offers 'Add tag' again", "Add tag" in text, text)



def seed_note(page, title: str, **extra) -> str:
    note_id = page.evaluate(SEED_NOTE_JS, [title, extra])
    page.wait_for_timeout(300)
    return note_id


def redraw_list(page) -> None:
    """Notes seeded straight into the store show up at the next list redraw; a search round trip forces one."""
    page.fill("#search", "Layout")
    page.wait_for_timeout(500)
    page.fill("#search", "")
    page.wait_for_timeout(500)


def open_by_title(page, title: str) -> None:
    page.click("#app-tab-notes", timeout=10000)
    redraw_list(page)
    page.locator(".note-item", has_text=title).first.click(timeout=10000, position={"x": 30, "y": 14})
    page.wait_for_function(
        "(t) => document.getElementById('note-title')?.value === t", arg=title, timeout=10000
    )
    page.wait_for_timeout(600)


def run_action(page, report: Report, where: str, action: dict, title: str, openers: list[str], control: str) -> None:
    """With `title` open: walk the visible openers, click `control`, check what it did."""
    label = f"[{where}] action {action['action']} through {' > '.join([*openers, control])}"
    try:
        page.evaluate(CLIPBOARD_SPY_JS)
        before = page.evaluate(NOTE_STATE_JS, title)
        for opener in openers:
            click_visible(page, opener)
        info = probe(page, control)
        if not report.check(label + ": control shown", info.get("present") and info.get("visible"), info):
            return
        report.check(label + ": control has an accessible name", bool(info["name"]), info)
        click_visible(page, control)
        page.wait_for_timeout(500)
        after = page.evaluate(NOTE_STATE_JS, title)
        if action["flag"]:
            flag = action["flag"]
            report.check(label + f": sets {flag}", not before[flag] and after[flag], (before, after))
        elif action["action"] == "duplicate":
            report.check(label + ": makes a copy", after["count"] == before["count"] + 1, (before, after))
        else:
            copied = page.evaluate("() => window.__copied")
            report.check(label + ": copies the note text", bool(copied) and "Synthetic body" in copied, copied)
    except Exception as err:  # noqa: BLE001 - reported as a failure
        report.check(label, False, first_line(err))


def quick_rows() -> list[dict]:
    rows = [row for row in ACTIONS if row["selector"] in QUICK_ROW]
    assert len(rows) == len(QUICK_ROW), "all six quick-row buttons must be in the table"
    return rows


def check_quick_row_desktop(page, report: Report) -> None:
    """Desktop: the quick row is not shown; each action lives in the control the table names."""
    by_selector = {row["selector"]: row for row in ACTIONS}
    open_fresh(page, PLAIN_TITLE)
    for opener in ("#btn-editor-overflow-desktop", "#btn-note-info"):
        click_visible(page, opener)
    report.check("[desktop] note info panel opens", probe(page, "#note-options-close").get("visible"))
    for row in quick_rows():
        info = probe(page, row["selector"])
        report.check(f"[desktop] {row['selector']} present", info["present"])
        report.check(f"[desktop] {row['selector']} is not shown in the desktop note info panel",
                     not info.get("visible"), info)
    click_visible(page, "#note-options-close")
    for index, row in enumerate(quick_rows()):
        if not report.check(f"{row['selector']} is marked phone-only in the table",
                            row["kind"] == "phone-only", row["reach"]):
            continue
        target = by_selector.get(row["desktop"])
        report.check(f"{row['selector']}: desktop control {row['desktop']} has its own row with the same openers",
                     bool(target) and target["kind"] in ("visible", "via")
                     and list(target["via"]) == list(row["desktop_via"]), row["reach"])
        title = f"Layout desktop action {index}"
        seed_note(page, title)
        reset_notes(page)
        try:
            open_by_title(page, title)
        except Exception as err:  # noqa: BLE001 - reported as a failure
            report.check(f"[desktop] open {title}", False, first_line(err))
            continue
        run_action(page, report, "desktop", QUICK_ROW[row["selector"]], title, row["desktop_via"], row["desktop"])


def phone_back_to_list(page) -> None:
    for selector in ("#note-options-close", "#btn-back"):
        loc = page.locator(selector).locator("visible=true")
        if loc.count():
            try:
                loc.first.click(timeout=3000)
            except Exception:  # noqa: BLE001 - the next open reports a real problem
                pass
            page.wait_for_timeout(400)


def open_fresh_phone(page, title: str) -> None:
    """Phone: back to the list, then open the note by tapping its list row (via the other note first)."""
    for name in (PDF_TITLE if title == PLAIN_TITLE else PLAIN_TITLE, title):
        escape_all(page)
        phone_back_to_list(page)
        reset_notes(page)
        open_by_title(page, name)


def check_quick_row_phone(page, report: Report) -> None:
    """Phone width: the quick row itself is shown in the note info panel and works."""
    for index, row in enumerate(quick_rows()):
        if row["kind"] != "phone-only":
            continue  # already reported by the desktop pass
        title = f"Layout phone action {index}"
        seed_note(page, title)
        try:
            open_by_title(page, title)
        except Exception as err:  # noqa: BLE001 - reported as a failure
            report.check(f"[phone] open {title}", False, first_line(err))
            continue
        run_action(page, report, "phone", QUICK_ROW[row["selector"]], title, row["phone_via"], row["selector"])
        phone_back_to_list(page)


SETTLED_JS = """(selector) => new Promise((resolve) => {
  const el = document.querySelector(selector);
  if (!el) return resolve(false);
  let last = null;
  const tick = () => requestAnimationFrame(() => {
    const busy = el.getAnimations({ subtree: true })
      .some((a) => a.playState === 'running' || a.playState === 'pending');
    const opacity = getComputedStyle(el).opacity;
    if (!busy && opacity === last) return resolve(true);
    last = opacity;
    tick();
  });
  tick();
})"""

ROW_LISTED_JS = """(title) => Array.from(document.querySelectorAll('.note-row .note-item'))
  .some((item) => (item.innerText || '').includes(title))"""


def settle(page, selector: str) -> None:
    """Wait until the element's CSS transitions have finished, so its opacity is its resting value."""
    page.wait_for_function(SETTLED_JS, arg=selector, timeout=5000)


def check_row_delete(page, report: Report) -> None:
    """`.note-row-delete` per row kind: shown on hover/focus, or replaced by the row menu."""
    row = next(r for r in ACTIONS if r["selector"] == ".note-row-delete")
    if not report.check(".note-row-delete is described per row kind in the table",
                        row["kind"] == "row-kind", row["reach"]):
        return
    titles = {kind: f"Layout row {kind}" for kind in ROW_KINDS}
    seed_note(page, titles["normal"])
    seed_note(page, titles["trashed"], trashed=True)
    seed_note(page, titles["locked"], locked=True)
    for kind in ROW_KINDS:
        expect = row["kinds"][kind]
        label = f"[desktop] .note-row-delete on a {kind} row"
        reset_notes(page)
        if kind == "trashed":
            show_view(page, "trash")
        redraw_list(page)
        page.wait_for_function(ROW_LISTED_JS, arg=titles[kind], timeout=10000)
        info = page.evaluate(ROW_JS, titles[kind])
        if not report.check(label + ": row is listed", bool(info), titles[kind]):
            continue
        report.check(label + ": present with an accessible name", info["hasDelete"] and bool(info["name"]), info)
        scope = '.note-row[data-layout-probe="1"]'
        page.locator(scope).hover()
        settle(page, f"{scope} .note-row-delete")
        hovered = probe(page, f"{scope} .note-row-delete")
        shown = bool(hovered.get("visible")) and hovered.get("opacity", 0) > 0.5
        report.check(label + (": shown on hover" if expect["shown"] else ": not shown, also not on hover"),
                     shown == expect["shown"], hovered)
        if expect["shown"]:
            page.mouse.move(1, 1)
            page.locator(f"{scope} .note-row-delete").focus()
            settle(page, f"{scope} .note-row-delete")
            focused = probe(page, f"{scope} .note-row-delete")
            report.check(label + ": present and reachable by keyboard focus",
                         focused.get("present") and focused.get("visible"), focused)
            report.check(label + ": row has no '…' menu", not info["hasMore"], info)
            continue
        # Not shown: the action must still be offered through the listed visible openers.
        *openers, control = expect["via"] or [None]
        if not report.check(label + ": table names where the action lives instead", bool(control), row["reach"]):
            continue
        try:
            for opener in openers:
                click_visible(page, f"{scope} {opener}")
            target = probe(page, control)
            report.check(label + f": action reachable through {' > '.join(expect['via'])}",
                         target.get("present") and target.get("visible") and bool(target.get("name")), target)
            click_visible(page, control)
            page.wait_for_timeout(400)
            state = page.evaluate(NOTE_STATE_JS, titles[kind])
            report.check(label + ": the menu item trashes the note", state["trashed"], state)
        except Exception as err:  # noqa: BLE001 - reported as a failure
            report.check(label + ": action reachable", False, first_line(err))


def seed_totp(page) -> None:
    page.click("#app-tab-2fa", timeout=10000)
    page.wait_for_timeout(400)
    page.click("#btn-totp-add", timeout=10000)
    page.fill("#totp-add-issuer", "Layout Test")
    page.fill("#totp-add-account", "layout@home.local")
    page.fill("#totp-add-secret", "JBSWY3DPEHPK3PXP")
    page.click("#totp-add-save")
    page.wait_for_selector("[data-totp-copy]", timeout=10000)


def tab_reset(page, tab: str):
    def reset() -> None:
        escape_all(page)
        page.click(tab, timeout=10000)
        page.wait_for_timeout(500)
    return reset


def main() -> int:
    from playwright.sync_api import sync_playwright

    report = Report()
    known = {"all", "notes", "plain", "pdf", "agenda", "2fa"}
    for row in ACTIONS:
        report.check(f"{row['selector']} applies to a known screen", row["applies"] in known, row["applies"])
        phone = row["phone_reach"]
        # A `via` reach without an opener would probe the control without opening anything.
        report.check(f"{row['selector']} names its openers in Reach and Phone reach",
                     all(spec["kind"] != "via" or spec["via"] for spec in (row, phone)),
                     f"{row['reach']} | {phone['text']}")

    proc, url = run_server()
    try:
        with sync_playwright() as pw:
            browser, page, _ids = boot(pw, url)
            page.wait_for_timeout(500)

            for where, title, scope in (("plain note", PLAIN_TITLE, "plain"), ("PDF note", PDF_TITLE, "pdf")):
                rows = [row for row in ACTIONS if row["applies"] in ("all", "notes", scope)]
                check_rows(page, report, where, rows, lambda title=title: open_fresh(page, title))

            check_rows(page, report, "agenda", [r for r in ACTIONS if r["applies"] in ("all", "agenda")],
                       tab_reset(page, "#app-tab-agenda"))
            seed_totp(page)
            check_rows(page, report, "2fa", [r for r in ACTIONS if r["applies"] in ("all", "2fa")],
                       tab_reset(page, "#app-tab-2fa"))

            for where, title, scope in (("plain note", PLAIN_TITLE, "plain"), ("PDF note", PDF_TITLE, "pdf")):
                check_header_layout(page, report, where, title)
                check_toolbar_buttons(page, report, where, title, scope)
                check_type_specific(page, report, where, title, scope)
            check_note_type_select(page, report)
            check_tag_summary(page, report)

            check_quick_row_desktop(page, report)
            check_row_delete(page, report)
            browser.close()

            time.sleep(1.1)  # register() derives the address from the clock
            browser = pw.chromium.launch(headless=True)
            phone = browser.new_context(viewport={"width": PHONE_WIDTH, "height": PHONE_HEIGHT},
                                        has_touch=True, is_mobile=True).new_page()
            register(phone, url)
            phone.evaluate(DISMISS_JS)
            phone.wait_for_timeout(500)
            check_quick_row_phone(phone, report)
            phone.evaluate(SEED_JS, base64.b64encode(make_pdf()).decode("ascii"))
            for where, title, scope in (("phone plain note", PLAIN_TITLE, "plain"),
                                        ("phone PDF note", PDF_TITLE, "pdf")):
                rows = [row for row in ACTIONS if row["applies"] in ("all", "notes", scope)]
                check_rows(phone, report, where, rows, lambda title=title: open_fresh_phone(phone, title),
                           reach="phone_reach")
            check_rows(phone, report, "phone agenda", [r for r in ACTIONS if r["applies"] in ("all", "agenda")],
                       tab_reset(phone, "#app-tab-agenda"), reach="phone_reach")
            seed_totp(phone)
            check_rows(phone, report, "phone 2fa", [r for r in ACTIONS if r["applies"] in ("all", "2fa")],
                       tab_reset(phone, "#app-tab-2fa"), reach="phone_reach")
            browser.close()
    finally:
        stop_server(proc)

    if report.failures:
        print(f"\n{len(report.failures)} of {report.checked} checks failed", file=sys.stderr)
        return 1
    print(f"OK - {len(ACTIONS)} table rows, {report.checked} checks: "
          "every action is present, named, reachable and working")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
