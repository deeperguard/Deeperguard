"""E2E: every existing shell action stays present, named and reachable.

Guards the layout restructure (idea #105, docs/UI_POLISH.md section 7). A
throwaway account with synthetic data opens Notes (a plain note and a PDF
note), Agenda and 2FA at desktop width. For every row of the control table in
section 7.2 (mirrored in ACTIONS below) the control must exist, have an
accessible name and be reachable: visible, or visible after opening the listed
visible menu/disclosure. Note-type specific actions are only checked on the
note type they apply to.

    python tests/e2e_layout_actions.py
"""
from __future__ import annotations

import base64
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

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


DOC = Path(__file__).resolve().parent.parent / "docs" / "UI_POLISH.md"
CONTEXTS = {"all": ("plain",), "notes": ("plain", "pdf"), "plain": ("plain",),
            "pdf": ("pdf",), "agenda": ("agenda",), "2fa": ("2fa",)}
# Disclosure toggles: clicking them again would close what the row needs open.
TOGGLES = ("#btn-nav-pin",)

TOTP_JS = """() => NotesStore.addTotpAccount({ issuer: 'Example', account: 'layout@example.test',
  secret: 'JBSWY3DPEHPK3PXP' })"""

NAME_JS = """(el) => {
  const txt = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    if (txt(t)) return txt(t);
  }
  if (txt(el.getAttribute('aria-label'))) return txt(el.getAttribute('aria-label'));
  if (el.labels && el.labels.length) {
    const t = Array.from(el.labels).map((l) => l.textContent).join(' ');
    if (txt(t)) return txt(t);
  }
  return txt(el.textContent) || txt(el.getAttribute('title')) || txt(el.getAttribute('placeholder'));
}"""


def load_actions():
    """Rows of the control table between the layout-actions markers."""
    text = DOC.read_text(encoding="utf-8")
    body = text.split("<!-- layout-actions:start -->", 1)[1].split("<!-- layout-actions:end -->", 1)[0]
    rows = []
    for line in body.splitlines():
        if not line.startswith("| `"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        reach = cells[5]
        openers = reach.split("`")[1::2] if reach.startswith("via") else []
        rows.append({"selector": cells[0].strip("`"), "name": cells[1], "applies": cells[4],
                     "reach": reach.split(":")[0].split(" ")[0], "openers": openers})
    if len(rows) < 100:
        raise SystemExit(f"control table looks truncated: {len(rows)} rows")
    return rows


def enter(page, ctx: str) -> None:
    for _ in range(3):
        page.keyboard.press("Escape")
    # Escape with no note open also folds the Views section; undo that test side effect.
    page.evaluate("() => { const s = document.getElementById('filter-section'); if (s) s.open = true; }")
    if ctx == "plain":
        open_note(page, "Layout plain note")
    elif ctx == "pdf":
        open_note(page, "Layout PDF note")
    elif ctx == "agenda":
        page.click("#app-tab-agenda", timeout=10000)
        page.wait_for_selector("#agenda-pane:not([hidden])", timeout=10000)
        page.wait_for_timeout(400)
    elif ctx == "2fa":
        page.click("#app-tab-2fa", timeout=10000)
        page.wait_for_selector("[data-totp-copy]", timeout=15000)


def check_row(page, row):
    if page.locator(row["selector"]).count() == 0:
        return "missing"
    loc = page.locator(row["selector"]).first
    if not loc.evaluate(NAME_JS):
        return "no accessible name"
    if row["reach"] == "conditional":
        return None
    for opener in row["openers"]:
        op = page.locator(opener).first
        if opener in TOGGLES and op.get_attribute("aria-expanded") == "true":
            continue
        if not op.is_visible():
            return f"opener {opener} not visible"
        op.click(timeout=5000)
        page.wait_for_timeout(350)
    if not loc.is_visible():
        return "not visible"
    return None


def check_all(page, actions) -> list:
    failures = []
    for ctx in ("plain", "pdf", "agenda", "2fa"):
        rows = sorted((r for r in actions if ctx in CONTEXTS.get(r["applies"], ())),
                      key=lambda r: r["reach"] == "via")
        enter(page, ctx)
        for row in rows:
            if row["reach"] == "via":
                enter(page, ctx)
            problem = check_row(page, row)
            if problem:
                failures.append(f"[{ctx}] {row['selector']} ({row['name']}): {problem}")
    return failures


def settle(page) -> None:
    """Move pointer and focus out of the sidebar so hover/focus-expansion is off."""
    page.mouse.move(WIDTH - 5, HEIGHT - 5)
    page.locator("#note-title").focus()
    page.wait_for_timeout(300)


def check_sidebar_toggle(page) -> list:
    """Collapse/expand: aria-expanded, labels, tooltips, state kept after reload."""
    failures = []
    enter(page, "plain")
    pin = page.locator("#btn-nav-pin")
    if pin.get_attribute("aria-expanded") != "true":
        pin.click()
    settle(page)
    if not page.locator("#btn-settings-nav .nav-label").is_visible():
        failures.append("expanded sidebar: footer label not visible")
    if not page.locator('.filter[data-filter="all"] > span').is_visible():
        failures.append("expanded sidebar: view label not visible")
    if page.locator(".filter.active").first.get_attribute("aria-current") != "page":
        failures.append("active view lacks aria-current=page")
    if page.locator("#btn-drawer-close").is_visible():
        failures.append("desktop: loose Close button still visible")
    pin.click()
    settle(page)
    if pin.get_attribute("aria-expanded") != "false":
        failures.append("collapse: aria-expanded not false")
    for sel in ("#sidebar .filter", ".sidebar-foot-actions .btn.icon"):
        for el in page.locator(sel).all():
            if not el.is_visible():
                continue
            if not (el.get_attribute("title") and el.evaluate(NAME_JS)):
                failures.append(f"collapsed: {sel} without tooltip or accessible name")
            label = el.locator(":scope > span")
            if label.count() and label.first.is_visible():
                failures.append(f"collapsed: {sel} still shows its label")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#btn-nav-pin", state="attached")
    stored = page.evaluate(
        "() => JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}').navPinned")
    if stored is not False or page.evaluate("() => document.body.classList.contains('nav-pinned')"):
        failures.append("collapsed state not kept after reload")
    return failures


def screenshots(page, out: Path) -> None:
    """Desktop (1440) and phone (390) shots of plain note, PDF note, Agenda, 2FA."""
    out.mkdir(parents=True, exist_ok=True)
    for width, height, tag in ((1440, 900, "desktop"), (390, 844, "phone")):
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_timeout(400)
        for ctx, title in (("plain", "Layout plain note"), ("pdf", "Layout PDF note"),
                           ("agenda", None), ("2fa", None)):
            if title:
                page.click("#app-tab-notes")
                page.wait_for_timeout(300)
                if page.locator("#btn-back").is_visible():
                    page.click("#btn-back")
                    page.wait_for_timeout(300)
                page.locator(".note-item", has_text=title).first.click()
                page.wait_for_timeout(1200)
            else:
                enter(page, ctx)
            page.screenshot(path=str(out / f"{ctx}-{tag}.png"))
    page.set_viewport_size({"width": WIDTH, "height": HEIGHT})


def main() -> int:
    import os

    from playwright.sync_api import sync_playwright

    actions = load_actions()
    proc, base = run_server()
    try:
        with sync_playwright() as pw:
            browser, page, _ids = boot(pw, base)
            try:
                page.evaluate(TOTP_JS)
                page.wait_for_function(
                    "() => document.querySelectorAll('.note-item').length >= 2", timeout=15000)
                # Optional proof shots: --screenshots DIR (or LAYOUT_SCREENSHOTS=DIR).
                shots = os.environ.get("LAYOUT_SCREENSHOTS")
                if "--screenshots" in sys.argv:
                    shots = sys.argv[sys.argv.index("--screenshots") + 1]
                if shots:
                    screenshots(page, Path(shots))
                failures = check_all(page, actions)
                failures += check_sidebar_toggle(page)
            finally:
                browser.close()
    finally:
        stop_server(proc)
    if failures:
        print("FAIL: layout actions")
        for line in failures:
            print("  -", line)
        return 1
    print(f"OK: {len(actions)} layout actions present, named and reachable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
