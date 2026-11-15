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
