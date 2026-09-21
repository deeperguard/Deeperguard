"""End-to-end check that a search paints a visible highlight on a document preview.

Boots a throwaway Deeperguard instance, uploads generated invoices (photo scan,
image-only PDF, digital PDF, and a two-page PDF whose match is on page 2), searches
for a word inside each, and asserts the highlight is word-sized, aligned over the
page and actually on screen. Screenshots land in /tmp/notes-e2e for inspection.

`tests/test_e2e_search_highlight.py` wraps this for `unittest discover`
(`E2E_SEARCH=1`) and skips when chromium, chromedriver, tesseract, or
poppler-utils are missing.
Run it directly when those tools are installed:

    python tests/e2e_search_highlight.py
"""
from __future__ import annotations

import base64
import mimetypes
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
QUERY = "Rodriguez"
OUT_DIR = Path(os.environ.get("E2E_OUT", "/tmp/notes-e2e"))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def font(size: int):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


INVOICE_LINES = [
    (60, 760, 18, "FACTURA SIMPLIFICADA"),
    (60, 720, 14, "Wasmachine Bosch WAN28"),
    (60, 690, 12, "Numero: 2020-004182"),
    (60, 665, 12, "Fecha: 09/12/2020"),
    (60, 600, 14, "TOTAL FACTURA 635,00 EUR"),
    (60, 570, 12, "Vencimiento 09/12/2020 635,00 EUR"),
    (60, 500, 14, "Le ha atendido Irene Rodriguez"),
    (60, 470, 12, "Muchas gracias por su compra"),
]


def make_text_pdf(path: Path, pages: list[list[tuple]] | None = None) -> Path:
    """A digital invoice PDF with a real embedded text layer, one or more pages."""
    page_specs = pages if pages is not None else [INVOICE_LINES]

    streams = []
    for lines in page_specs:
        content = ["BT"]
        for x, y, size, text in lines:
            content.append(f"/F1 {size} Tf 1 0 0 1 {x} {y} Tm ({text}) Tj")
        content.append("ET")
        streams.append("\n".join(content).encode("latin-1"))

    font_obj = 3 + 2 * len(streams)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(len(streams)))

    objects: list[bytes] = [
        b"<</Type /Catalog /Pages 2 0 R>>",
        f"<</Type /Pages /Kids [{kids}] /Count {len(streams)}>>".encode(),
    ]
    for index, stream in enumerate(streams):
        content_obj = 4 + 2 * index
        objects.append(
            f"<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources <</Font <</F1 {font_obj} 0 R>>>> /Contents {content_obj} 0 R>>".encode()
        )
        objects.append(
            b"<</Length " + str(len(stream)).encode() + b">>\nstream\n" + stream + b"\nendstream"
        )
    objects.append(
        b"<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>"
    )

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<</Size {len(objects) + 1} /Root 1 0 R>>\nstartxref\n{xref_at}\n%%EOF\n".encode()
    )
    path.write_bytes(bytes(out))
    return path


def make_two_page_pdf(path: Path) -> Path:
    """The searched name only appears on page 2 — the case that looks broken."""
    page_one = [
        (60, 760, 18, "FACTURA SIMPLIFICADA"),
        (60, 720, 14, "Wasmachine Bosch WAN28"),
        (60, 690, 12, "Numero: 2020-004182"),
        (60, 600, 14, "TOTAL FACTURA 635,00 EUR"),
    ]
    page_two = [
        (60, 760, 14, "Condiciones de garantia"),
        (60, 500, 14, "Le ha atendido Irene Rodriguez"),
        (60, 470, 12, "Muchas gracias por su compra"),
    ]
    return make_text_pdf(path, [page_one, page_two])


def make_scanned_pdf(path: Path) -> Path:
    """An image-only PDF, like a phone scan saved as PDF."""
    jpg = make_invoice(path.with_suffix(".src.jpg"))
    with Image.open(jpg) as img:
        img.convert("RGB").save(path, format="PDF", resolution=150)
    return path


def make_invoice(path: Path) -> Path:
    """A photo-like scan of an invoice, similar to a phone camera capture."""
    img = Image.new("RGB", (1240, 1754), "white")
    d = ImageDraw.Draw(img)
    big = font(46)
    mid = font(34)
    small = font(30)
    d.text((70, 90), "FACTURA SIMPLIFICADA", fill="black", font=big)
    d.text((70, 200), "Wasmachine Bosch WAN28", fill="black", font=mid)
    d.text((70, 280), "Numero: 2020-004182", fill="black", font=small)
    d.text((70, 340), "Fecha: 09/12/2020", fill="black", font=small)
    d.text((70, 520), "TOTAL FACTURA 635,00 EUR", fill="black", font=mid)
    d.text((70, 600), "Vencimiento 09/12/2020 635,00 EUR", fill="black", font=small)
    d.text((70, 760), "Le ha atendido Irene Rodriguez", fill="black", font=mid)
    d.text((70, 840), "Muchas gracias por su compra", fill="black", font=small)
    d.rectangle((60, 60, 1180, 900), outline="black", width=3)
    img.save(path, format="JPEG", quality=88)
    return path


def start_server(root: Path, port: int):
    env = dict(os.environ)
    env.update(
        NOTES_ROOT=str(root),
        NOTES_DATA=str(root / "data"),
        NOTES_KEYS=str(root / "keys"),
        NOTES_ALLOWED_CIDRS="127.0.0.1/32",
        NOTES_SKIP_LOGIN="0",
        FLASK_APP="app",
        PYTHONPATH=str(APP_DIR),
    )
    (root / "keys").mkdir(parents=True, exist_ok=True)
    (root / "keys" / "flask-secret").write_text("e2e-secret", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-m", "flask", "run", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(APP_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    for _ in range(80):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return proc
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError((proc.stdout.read() or b"").decode())
            time.sleep(0.25)
    raise RuntimeError("server did not start")


def make_driver():
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service

    opts = Options()
    opts.binary_location = "/usr/bin/chromium"
    for flag in (
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=430,932",
    ):
        opts.add_argument(flag)
    driver = webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=opts)
    driver.set_script_timeout(int(os.environ.get("E2E_SCRIPT_TIMEOUT", "180")))
    return driver


def unlock_app(driver, wait, base: str) -> None:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    driver.get(f"{base}/register")
    driver.find_element(By.NAME, "email").send_keys("e2e@home.local")
    driver.find_element(By.NAME, "password").send_keys("e2e-password-1234")
    driver.find_element(By.NAME, "password2").send_keys("e2e-password-1234")
    driver.find_element(By.CSS_SELECTOR, "#register-form button[type=submit]").click()

    wait.until(EC.presence_of_element_located((By.ID, "app")))
    unlock = driver.find_elements(By.ID, "unlock-password")
    if unlock and unlock[0].is_displayed():
        unlock[0].send_keys("e2e-password-1234")
        wait.until(lambda d: d.find_element(By.ID, "unlock-submit").is_enabled())
        driver.find_element(By.ID, "unlock-submit").click()
    wait.until(lambda d: d.execute_script(
        "return !!window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked();"
    ))


def attachment_count(driver) -> int:
    return driver.execute_script(
        """
        return NotesStore.listNotes()
          .flatMap((n) => NotesStore.listAttachments(n.uuid)).length;
        """
    )


def processed_count(driver) -> int:
    return driver.execute_script(
        """
        return NotesStore.listNotes()
          .flatMap((n) => NotesStore.listAttachments(n.uuid))
          .filter((a) => a.content.ocr_method).length;
        """
    )


def upload_document(driver, wait, path: Path, name: str) -> None:
    """Create a document note via the encrypted store and server OCR (avoids scan UI flake)."""
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    result = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const raw = atob(arguments[0]);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
            const file = new File([bytes], arguments[1], { type: arguments[2] });
            const title = arguments[3];
            const noteId = NotesStore.newUuid();
            NotesStore.upsert(noteId, {
              ...NotesStore.defaultNote(),
              title,
              attachments: [],
            });
            const attId = await NotesStore.addAttachment(noteId, file, { displayName: title });
            const ocr = await NotesOcr.extractFromFile(file, null, attId);
            NotesStore.setAttachmentOcr(
              attId,
              ocr.text || '',
              ocr.method || 'server',
              Array.isArray(ocr.boxes) ? ocr.boxes : [],
            );
            NotesStore.refreshNoteSearchText(noteId);
            done({
              ok: true,
              noteId,
              attId,
              textLen: String(ocr.text || '').length,
              method: ocr.method || '',
            });
          } catch (err) {
            done({ ok: false, error: err.message || String(err) });
          }
        })();
        """,
        payload,
        path.name,
        mime,
        name,
    )
    if not result or not result.get("ok"):
        raise RuntimeError(result.get("error") if result else "upload failed")
    if not result.get("textLen"):
        raise RuntimeError(f"OCR returned no text for {name} ({result})")


def probe(driver, label: str, note_title: str) -> dict:
    driver.execute_script("document.getElementById('btn-back')?.click();")
    time.sleep(0.4)
    driver.execute_script(
        """
        const s = document.getElementById('search');
        s.value = arguments[0];
        s.dispatchEvent(new Event('input', { bubbles: true }));
        """,
        QUERY,
    )
    time.sleep(1.2)
    opened = driver.execute_script(
        """
        const rows = [...document.querySelectorAll('.note-item')];
        const row = rows.find((r) => r.textContent.includes(arguments[0])) || rows[0];
        if (!row) return false;
        row.click();
        return true;
        """,
        note_title,
    )
    if not opened:
        return {"label": label, "error": "search returned no notes"}

    deadline = time.time() + 60
    hits: list = []
    settled = False
    while time.time() < deadline:
        hits = driver.execute_script(
            """
            return [...document.querySelectorAll('.doc-search-hit')].map((el) => {
              const r = el.getBoundingClientRect();
              const host = el.closest('.doc-page-wrap');
              const h = host ? host.getBoundingClientRect() : null;
              const media = host ? host.querySelector('img, canvas.doc-page') : null;
              const m = media ? media.getBoundingClientRect() : null;
              return {
                w: Math.round(r.width), h: Math.round(r.height),
                styleW: el.style.width, styleH: el.style.height,
                hostW: h ? Math.round(h.width) : 0, hostH: h ? Math.round(h.height) : 0,
                mediaW: m ? Math.round(m.width) : 0, mediaH: m ? Math.round(m.height) : 0,
                dxFromMedia: m ? Math.round(r.left - m.left) : null,
                dyFromMedia: m ? Math.round(r.top - m.top) : null,
                insideMedia: !!m && r.left >= m.left - 1 && r.top >= m.top - 1
                  && r.right <= m.right + 1 && r.bottom <= m.bottom + 1,
                visible: r.width > 0 && r.height > 0,
              };
            });
            """
        )
        if hits:
            # The preview repaints as pages finish rendering; wait for the
            # highlight to settle inside the viewport before judging it.
            settled = driver.execute_script(
                """
                const hit = document.querySelector('.doc-search-hit');
                if (!hit) return false;
                const r = hit.getBoundingClientRect();
                return r.top >= 0 && r.bottom <= (window.innerHeight || 0);
                """
            )
            if settled:
                break
        time.sleep(0.5)

    timeline = []
    if not settled:
        for _ in range(16):
            timeline.append(driver.execute_script(
                """
                const hit = document.querySelector('.doc-search-hit');
                const inline = document.querySelector('.doc-inline');
                const r = hit ? hit.getBoundingClientRect() : null;
                return {
                  hits: document.querySelectorAll('.doc-search-hit').length,
                  pages: document.querySelectorAll('.doc-page-wrap').length,
                  scroll: inline ? Math.round(inline.scrollTop) : null,
                  max: inline ? inline.scrollHeight - inline.clientHeight : null,
                  top: r ? Math.round(r.top) : null,
                };
                """
            ))
            time.sleep(0.25)

    state = driver.execute_script(
        """
        const note = NotesStore.listNotes().find((n) => (n.content.title || '') === arguments[0])
          || NotesStore.listNotes()[0];
        const att = note ? NotesStore.listAttachments(note.uuid)[0] : null;
        const hit = document.querySelector('.doc-search-hit');
        const stage = document.querySelector('.doc-inline-stage');
        let hitInView = null;
        let hitTop = null;
        if (hit) {
          const r = hit.getBoundingClientRect();
          hitInView = r.top >= 0 && r.bottom <= (window.innerHeight || 0);
          hitTop = Math.round(r.top);
        }
        return {
          hitInViewport: hitInView,
          hitTop,
          winH: window.innerHeight,
          badge: document.querySelector('.doc-hit-note')?.textContent || null,
          stageScroll: stage ? Math.round(stage.scrollTop) : null,
          filename: att ? att.content.filename : '',
          boxes: att ? (att.content.ocr_boxes || []).length : -1,
          method: att ? att.content.ocr_method : '',
          ocrLen: att ? (att.content.ocr_text || '').length : 0,
          pages: document.querySelectorAll('.doc-page-wrap').length,
          canvases: document.querySelectorAll('.doc-inline-stage canvas').length,
          imgs: document.querySelectorAll('.doc-inline-stage img').length,
          excerpt: !!document.querySelector('.doc-ocr-hits'),
        };
        """,
        note_title,
    )
    return {"label": label, "hits": hits, "state": state, "timeline": timeline}


def main() -> int:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="notes-e2e-"))
    docs = [
        ("photo scan (jpg)", make_invoice(OUT_DIR / "invoice-photo.jpg")),
        ("scanned pdf (image only)", make_scanned_pdf(OUT_DIR / "invoice-scanned.pdf")),
        ("digital pdf (text layer)", make_text_pdf(OUT_DIR / "invoice-digital.pdf")),
        ("two page pdf (match on page 2)", make_two_page_pdf(OUT_DIR / "invoice-2page.pdf")),
    ]
    port = free_port()
    server = start_server(tmp, port)
    base = f"http://127.0.0.1:{port}"
    driver = None
    failures = []
    try:
        driver = make_driver()
        wait = WebDriverWait(driver, 240)
        unlock_app(driver, wait, base)

        for label, path in docs:
            title = f"Invoice {label}"
            upload_document(driver, wait, path, title)
            result = probe(driver, label, title)
            shot = OUT_DIR / f"{path.stem}.png"
            driver.save_screenshot(str(shot))
            wraps = driver.find_elements(By.CSS_SELECTOR, ".doc-inline-stage .doc-page-wrap")
            if wraps:
                (OUT_DIR / f"{path.stem}-page.png").write_bytes(wraps[0].screenshot_as_png)
            print(f"\n=== {label} ===")
            if result.get("error"):
                print(f"  ERROR: {result['error']}")
                failures.append(label)
                continue
            print(f"  stored: {result['state']}")
            print(f"  highlights: {result['hits']}")
            print(f"  screenshot: {shot}")
            hits = result["hits"]
            state = result["state"]
            if not hits:
                print("  FAIL: no highlight painted on the page")
                failures.append(label)
                continue
            bad = [
                h for h in hits
                if not h["visible"] or h["w"] > h["hostW"] * 0.6 or h["h"] > h["hostH"] * 0.25
            ]
            if bad:
                print(f"  FAIL: highlight geometry wrong: {bad[:3]}")
                failures.append(label)
                continue
            offset = [h for h in hits if not h["insideMedia"]]
            if offset:
                print(f"  FAIL: highlight not aligned over the page image: {offset[:3]}")
                failures.append(label)
                continue
            if not state["pages"]:
                print("  FAIL: document page not rendered")
                failures.append(label)
                continue
            if not state["hitInViewport"]:
                print("  FAIL: highlight painted but never scrolled into view")
                for row in result.get("timeline", []):
                    print(f"    {row}")
                failures.append(label)
                continue
            print(f"  PASS: {len(hits)} word-sized highlight(s), visible on screen")

        for entry in driver.get_log("browser"):
            if entry["level"] == "SEVERE" and "favicon" not in entry["message"]:
                print(f"console SEVERE: {entry['message'][:240]}")

        if failures:
            print(f"\nFAILED: {failures}")
            return 1
        print("\nALL CASES PASS")
        return 0
    finally:
        if driver:
            driver.quit()
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
