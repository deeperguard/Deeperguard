"""End-to-end check that Deeperguard unlocks and reads the vault offline.

Boots a throwaway instance, registers, creates a note, enables remember-device,
clears session storage (simulating an iOS force-quit), goes offline via CDP,
reloads, asserts the vault stays locked, then unlocks offline and the note is still readable.

Also uploads a photo with embedded text and verifies it is searchable like a PDF.

Run directly when Chromium and chromedriver are installed:

    python tests/e2e_offline_vault.py
"""
from __future__ import annotations

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
OUT_DIR = Path(os.environ.get("E2E_OUT", "/tmp/notes-e2e"))
IMAGE_TOKEN = "FINDME123"
HEIC_TOKEN = "HEICFIND99"
NOTE_TITLE = "Offline vault note"
NOTE_BODY = "Secret offline content for e2e verification"
PASSWORD = "e2e-password-1234"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def font(size: int):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def make_labeled_photo(path: Path) -> Path:
    img = Image.new("RGB", (900, 500), "white")
    draw = ImageDraw.Draw(img)
    draw.text((40, 40), f"Scan label: {IMAGE_TOKEN}", fill="black", font=font(36))
    draw.text((40, 100), "Deeperguard image OCR test", fill="black", font=font(20))
    img.save(path, format="JPEG", quality=90)
    return path


def make_labeled_heic(path: Path) -> Path:
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except ImportError as exc:
        raise RuntimeError("pillow_heif required for HEIC E2E") from exc
    img = Image.new("RGB", (900, 500), "white")
    draw = ImageDraw.Draw(img)
    draw.text((40, 40), f"Direct HEIC: {HEIC_TOKEN}", fill="black", font=font(36))
    draw.text((40, 100), "Deeperguard HEIC OCR test", fill="black", font=font(20))
    img.save(path, format="HEIF")
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
    (root / "keys" / "flask-secret").write_text("e2e-offline-secret", encoding="utf-8")
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
    opts.set_capability("goog:loggingPrefs", {"browser": "SEVERE"})
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
    driver.find_element(By.NAME, "email").send_keys("offline@home.local")
    driver.find_element(By.NAME, "password").send_keys(PASSWORD)
    driver.find_element(By.NAME, "password2").send_keys(PASSWORD)
    driver.find_element(By.CSS_SELECTOR, "#register-form button[type=submit]").click()

    wait.until(EC.presence_of_element_located((By.ID, "app")))
    if driver.execute_script(
        "return !!window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked();"
    ):
        driver.execute_script(
            "localStorage.setItem('notes_email', arguments[0]);",
            "offline@home.local",
        )
        return
    wait.until(lambda d: d.find_element(By.ID, "unlock-submit").is_enabled())
    driver.execute_script(
        """
        const field = document.getElementById('unlock-password');
        if (field) {
          field.value = arguments[0];
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const btn = document.getElementById('unlock-submit');
        if (btn && !btn.disabled) btn.click();
        """,
        PASSWORD,
    )
    wait.until(lambda d: d.execute_script(
        "return !!window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked();"
    ))
    driver.execute_script(
        "localStorage.setItem('notes_email', arguments[0]);",
        "offline@home.local",
    )


def create_text_note(driver, wait) -> str:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    note_id = driver.execute_script(
        """
        const id = NotesStore.newUuid();
        NotesStore.upsert(id, {
          ...NotesStore.defaultNote(),
          title: arguments[0],
          content: arguments[1],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return id;
        """,
        NOTE_TITLE,
        NOTE_BODY,
    )
    driver.execute_script(
        """
        document.body.classList.remove('editor-open');
        const btn = document.querySelector('.filter[data-filter="all"]');
        if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        """,
    )
    wait.until(
        lambda d: d.execute_script(
            "return [...document.querySelectorAll('.note-item')].some((r) => r.dataset.id === arguments[0]);",
            note_id,
        )
    )
    return note_id


def enable_remember_device(driver) -> None:
    driver.execute_script(
        """
        const prefs = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}');
        prefs.rememberDevice = true;
        localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs));
        localStorage.setItem('notes_device_password', arguments[0]);
        """,
        PASSWORD,
    )


def upload_photo(driver, wait, ocr_wait, path: Path, name: str) -> None:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    before = driver.execute_script(
        "return NotesStore.listNotes().flatMap((n) => NotesStore.listAttachments(n.uuid)).length;"
    )
    scan_input = wait.until(EC.presence_of_element_located((By.ID, "scan-input")))
    scan_input.send_keys(str(path))
    wait.until(EC.visibility_of_element_located((By.ID, "scan-name")))
    field = wait.until(EC.element_to_be_clickable((By.ID, "scan-name")))
    field.clear()
    field.send_keys(name)
    driver.find_element(By.ID, "scan-confirm").click()
    ocr_wait.until(
        lambda d: d.execute_script(
            "return NotesStore.listNotes().flatMap((n) => NotesStore.listAttachments(n.uuid)).length > arguments[0];",
            before,
        )
    )
    ocr_wait.until(
        lambda d: d.execute_script(
            """
            const token = arguments[0];
            return NotesStore.listAttachments().some((a) =>
              (a.content.ocr_text || '').includes(token)
            ) && NotesStore.listNotes().some((n) =>
              (n.content.ocr_text || '').includes(token)
            );
            """,
            IMAGE_TOKEN,
        ),
        message="image OCR text not indexed",
    )


def send_attachment_file(driver, path: Path) -> None:
    from selenium.webdriver.common.by import By
    from selenium.common.exceptions import StaleElementReferenceException

    last_err = None
    for _ in range(4):
        try:
            driver.find_element(By.ID, "attachment-input").send_keys(str(path))
            return
        except StaleElementReferenceException as err:
            last_err = err
            time.sleep(0.25)
    raise last_err or RuntimeError("attachment input not found")


def attach_single_file_direct(driver, wait, note_title: str, path: Path) -> None:
    """Pick one file on an open note — must attach without opening scan dialog."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    driver.execute_script(
        """
        const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
        if (!note) return false;
        const openTitle = document.getElementById('note-title')?.value || '';
        if (openTitle.includes(arguments[0]) && !document.getElementById('editor')?.hidden) return true;
        const row = [...document.querySelectorAll('.note-item')].find((r) => r.dataset.id === note.uuid);
        if (row) row.click();
        return !!row;
        """,
        note_title,
    )
    wait.until(EC.visibility_of_element_located((By.ID, "attachment-input")))
    before = driver.execute_script(
        """
        const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
        return note ? NotesStore.listAttachments(note.uuid).length : 0;
        """,
        note_title,
    )
    send_attachment_file(driver, path)
    wait.until(
        lambda d: d.execute_script(
            """
            const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
            return note && NotesStore.listAttachments(note.uuid).length > arguments[1];
            """,
            note_title,
            before,
        )
    )
    scan_hidden = driver.execute_script(
        "return document.getElementById('scan-dialog').hidden;"
    )
    if not scan_hidden:
        raise AssertionError("scan dialog opened for single-file attach on existing note")
    print("PASS: single-file attach skips scan dialog")


def attach_image_direct_with_ocr(
    driver,
    wait,
    ocr_wait,
    note_title: str,
    path: Path,
    token: str,
    *,
    simulate_ios_offline: bool = False,
) -> None:
    """Attach one image on an open note and wait until OCR text is searchable."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    if simulate_ios_offline:
        driver.execute_script(
            """
            try {
              Object.defineProperty(navigator, 'onLine', {
                configurable: true,
                get() { return false; },
              });
            } catch (err) { /* best effort */ }
            """
        )
        offline = driver.execute_script("return navigator.onLine === false;")
        if not offline:
            raise AssertionError("could not simulate iOS offline navigator.onLine")

    driver.execute_script(
        """
        const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
        if (!note) return false;
        const openTitle = document.getElementById('note-title')?.value || '';
        if (openTitle.includes(arguments[0]) && !document.getElementById('editor')?.hidden) return true;
        const row = [...document.querySelectorAll('.note-item')].find((r) => r.dataset.id === note.uuid);
        if (row) row.click();
        return !!row;
        """,
        note_title,
    )
    wait.until(EC.visibility_of_element_located((By.ID, "attachment-input")))
    before = driver.execute_script(
        """
        const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
        return note ? NotesStore.listAttachments(note.uuid).length : 0;
        """,
        note_title,
    )
    send_attachment_file(driver, path)
    ocr_wait.until(
        lambda d: d.execute_script(
            """
            const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
            return note && NotesStore.listAttachments(note.uuid).length > arguments[1];
            """,
            note_title,
            before,
        )
    )
    scan_hidden = driver.execute_script(
        "return document.getElementById('scan-dialog').hidden;"
    )
    if not scan_hidden:
        raise AssertionError("scan dialog opened for single-file image attach")
    ocr_wait.until(
        lambda d: d.execute_script(
            """
            const token = arguments[0];
            return NotesStore.listAttachments().some((a) =>
              (a.content.ocr_text || '').includes(token)
            ) && NotesStore.listNotes().some((n) =>
              (n.content.ocr_text || '').includes(token)
            );
            """,
            token,
        ),
        message=f"direct image OCR text not indexed ({path.name})",
    )
    parts = ["HEIC direct attach OCR"]
    if simulate_ios_offline:
        parts.append("iOS offline flag")
    print(f"PASS: {' with '.join(parts)}")


def verify_session_bootstrap_without_cookie(driver) -> None:
    """Cached PWA shells may have no session cookie until password unlock."""
    driver.delete_all_cookies()
    ok = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        const run = async () => {
          if (typeof window.notesEnsureServerSession !== 'function') return false;
          return window.notesEnsureServerSession();
        };
        run().then((value) => done(!!value)).catch(() => done(false));
        """
    )
    csrf = driver.execute_script(
        "return typeof NotesStore !== 'undefined' && typeof NotesStore.csrf === 'function' ? NotesStore.csrf() : '';"
    )
    if not ok or not csrf:
        raise AssertionError("server session did not bootstrap after clearing cookies")
    print("PASS: PWA session bootstrap without cookie")


def verify_document_opens_in_preview(driver, wait, note_title_part: str) -> None:
    """Photo/PDF notes should open in document preview, not an empty textarea."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    clicked = driver.execute_script(
        """
        const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
        if (!note) return false;
        const row = [...document.querySelectorAll('.note-item')].find((r) => r.dataset.id === note.uuid);
        if (row) row.click();
        return !!row;
        """,
        note_title_part,
    )
    if not clicked:
        raise AssertionError("document note missing from list")
    wait.until(EC.visibility_of_element_located((By.ID, "doc-inline")))
    state = driver.execute_script(
        """
        const inline = document.getElementById('doc-inline');
        const body = document.getElementById('note-body');
        return {
          ok: !!(inline && !inline.hidden && body && body.hidden),
          inlineHidden: inline ? inline.hidden : null,
          bodyHidden: body ? body.hidden : null,
        };
        """,
    )
    if not state or not state.get("ok"):
        raise AssertionError(f"document note not in preview mode: {state}")
    print("PASS: document note opens in preview")


def verify_find_in_ocr(driver, wait, token: str) -> None:
    """Mobile find bar should search OCR text on document notes."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    driver.find_element(By.ID, "btn-find").click()
    wait.until(lambda d: d.find_element(By.ID, "find-bar").is_displayed())
    find_input = wait.until(EC.element_to_be_clickable((By.ID, "find-input")))
    find_input.clear()
    find_input.send_keys(token)
    driver.execute_script(
        """
        const input = document.getElementById('find-input');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        """,
    )
    time.sleep(0.6)
    count = driver.find_element(By.ID, "find-count").text or ""
    hits = driver.execute_script(
        """
        const previewHits = document.querySelectorAll('#preview mark.search-hit').length;
        const docHits = document.querySelectorAll('.doc-inline-stage .doc-search-hit, #doc-stage .doc-search-hit').length;
        return { previewHits, docHits, total: previewHits + docHits };
        """
    )
    total = (hits or {}).get("total") or 0
    if count == "0/0" or not total:
        raise AssertionError(f"find in note did not match OCR text (count={count!r}, hits={hits})")
    print(f"PASS: find in note searches OCR text ({count}, {total} highlight(s))")


def verify_note_action_buttons(driver, wait, note_title_part: str, password: str) -> None:
    """Exercise star/pin/protect/duplicate/trash on a note that has an attachment."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    driver.execute_script(
        """
        const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
        if (!note) return false;
        const row = [...document.querySelectorAll('.note-item')].find((r) => r.dataset.id === note.uuid);
        if (row) row.click();
        return !!row;
        """,
        note_title_part,
    )
    wait.until(EC.visibility_of_element_located((By.ID, "btn-star")))
    note_id = driver.execute_script(
        """
        const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
        return note ? note.uuid : '';
        """,
        note_title_part,
    )
    if not note_id:
        raise AssertionError(f"note not found: {note_title_part!r}")

    orig_att_ids = driver.execute_script(
        "return NotesStore.listAttachments(arguments[0]).map((a) => a.uuid);",
        note_id,
    )
    if not orig_att_ids:
        raise AssertionError("expected note with attachment for button checks")

    driver.find_element(By.ID, "btn-star").click()
    time.sleep(0.2)
    if not driver.execute_script(
        "return !!NotesStore.get(arguments[0])?.content?.starred;", note_id
    ):
        raise AssertionError("star toggle failed")

    driver.find_element(By.ID, "btn-pin").click()
    time.sleep(0.2)
    if not driver.execute_script(
        "return !!NotesStore.get(arguments[0])?.content?.pinned;", note_id
    ):
        raise AssertionError("pin toggle failed")

    driver.find_element(By.ID, "btn-archive").click()
    time.sleep(0.2)
    if not driver.execute_script(
        "return !!NotesStore.get(arguments[0])?.content?.archived;", note_id
    ):
        raise AssertionError("archive toggle failed")
    driver.find_element(By.ID, "btn-archive").click()
    time.sleep(0.2)

    driver.find_element(By.ID, "btn-note-info").click()
    wait.until(
        lambda d: d.execute_script(
            "return !document.getElementById('note-options').hidden;"
        )
    )
    driver.find_element(By.ID, "note-info-protect").click()
    wait.until(
        lambda d: d.execute_script(
            "return !document.getElementById('note-lock-gate').hidden;"
        )
    )
    driver.find_element(By.ID, "note-lock-password").send_keys(password)
    driver.find_element(By.ID, "note-lock-unlock").click()
    wait.until(
        lambda d: d.execute_script(
            "return document.getElementById('note-lock-gate').hidden;"
        )
    )

    before_notes = driver.execute_script("return NotesStore.listNotes().length;")
    driver.find_element(By.ID, "btn-duplicate").click()
    wait.until(
        lambda d: d.execute_script(
            "return NotesStore.listNotes().length > arguments[0];", before_notes
        )
    )
    copy_id = driver.execute_script(
        """
        const copy = NotesStore.listNotes().find((n) =>
          (n.content.title || '').includes(' copy') && n.uuid !== arguments[0]
        );
        return copy ? copy.uuid : '';
        """,
        note_id,
    )
    if not copy_id:
        raise AssertionError("duplicate note not created")
    copy_att_ids = driver.execute_script(
        "return NotesStore.listAttachments(arguments[0]).map((a) => a.uuid);",
        copy_id,
    )
    if not copy_att_ids:
        raise AssertionError("duplicate missing attachments")
    if set(copy_att_ids) & set(orig_att_ids):
        raise AssertionError("duplicate shares attachment UUIDs with original")

    driver.find_element(By.ID, "btn-trash").click()
    time.sleep(0.3)
    if not driver.execute_script(
        "return !!NotesStore.get(arguments[0])?.content?.trashed;", copy_id
    ):
        raise AssertionError("trash toggle failed")
    print("PASS: star/pin/archive/protect/duplicate/trash buttons")


def verify_stale_search_index_repair(driver, token: str) -> None:
    """Simulate attachment OCR present but note search index empty; query should repair."""
    stale = driver.execute_script(
        """
        const token = arguments[0];
        const note = NotesStore.listNotes().find((n) =>
          NotesStore.listAttachments(n.uuid).some((a) => (a.content.ocr_text || '').includes(token))
        );
        if (!note) return { ok: false, reason: 'no note with attachment OCR' };
        const attOcr = NotesStore.listAttachments(note.uuid)
          .map((a) => a.content.ocr_text).filter(Boolean).join('\\n\\n');
        if (!attOcr.includes(token)) return { ok: false, reason: 'attachment missing token' };
        NotesStore.upsert(note.uuid, {
          ...note.content,
          ocr_text: '',
          attachment_names: note.content.attachment_names || '',
        });
        const noteAfter = NotesStore.get(note.uuid);
        const staleNow = String(noteAfter.content.ocr_text || '') !== attOcr;
        return { ok: true, stale: staleNow, noteId: note.uuid };
        """,
        token,
    )
    if not stale or not stale.get("ok"):
        raise AssertionError(f"could not simulate stale search index: {stale}")
    if not stale.get("stale"):
        raise AssertionError("note search index was not stale after simulation")

    driver.execute_script(
        """
        const s = document.getElementById('search');
        s.value = arguments[0];
        s.dispatchEvent(new Event('input', { bubbles: true }));
        """,
        token,
    )
    time.sleep(0.5)
    matches = driver.execute_script(
        """
        const token = arguments[0];
        const listHits = [...document.querySelectorAll('.note-item')]
          .filter((r) => r.textContent.includes(token)).length;
        const noteHits = NotesStore.listNotes()
          .filter((n) => (n.content.ocr_text || '').includes(token)).length;
        return { listHits, noteHits };
        """,
        token,
    )
    if not matches or not matches.get("listHits"):
        raise AssertionError(f"stale search index not repaired on query (list={matches})")
    if not matches.get("noteHits"):
        raise AssertionError("note.ocr_text not repaired after search input")
    print("PASS: stale search index auto-repaired on query")


def verify_all_device_tests(driver) -> None:
    """Settings → Run all device tests: OCR search, note buttons, single-file attach."""
    ok = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        const run = async () => {
          if (typeof window.notesRunAllDeviceTests !== 'function') return false;
          return window.notesRunAllDeviceTests();
        };
        run().then((value) => done(!!value)).catch(() => done(false));
        """
    )
    if not ok:
        diag = driver.execute_script(
            """
            const el = document.getElementById('privacy-status');
            return el ? el.textContent : '';
            """
        )
        raise AssertionError(f"all device tests failed ({diag or 'no diagnostics'})")
    driver.execute_script(
        """
        const s = document.getElementById('search');
        if (s && s.value) {
          s.value = '';
          s.dispatchEvent(new Event('input', { bubbles: true }));
        }
        """
    )
    print("PASS: all device tests")


def verify_device_report_uploaded(data_root: Path) -> None:
    """Run all device tests should POST checklist to /api/device-report."""
    latest = data_root / "device-reports" / "latest.txt"
    if not latest.is_file() or latest.stat().st_size < 20:
        raise AssertionError("device report not stored on server after device tests")
    text = latest.read_text(encoding="utf-8")
    if "iPhone checklist" not in text:
        raise AssertionError(f"device report missing checklist ({text[:160]!r})")
    if "Photo OCR search" not in text and "Photo search self-test" not in text:
        raise AssertionError("device report missing photo OCR status")
    print("PASS: device report uploaded to server")


def verify_photo_search_self_test(driver, ocr_wait) -> None:
    """Settings → Test photo search: canvas PNG → OCR → search index → list query."""
    ok = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        const run = async () => {
          if (typeof window.notesRunPhotoSearchSelfTest !== 'function') return false;
          return window.notesRunPhotoSearchSelfTest();
        };
        run().then((value) => done(!!value)).catch(() => done(false));
        """
    )
    if not ok:
        diag = driver.execute_script(
            """
            const el = document.getElementById('privacy-status');
            return el ? el.textContent : '';
            """
        )
        raise AssertionError(f"photo search self-test failed ({diag or 'no diagnostics'})")
    driver.execute_script(
        """
        const s = document.getElementById('search');
        if (s && s.value) {
          s.value = '';
          s.dispatchEvent(new Event('input', { bubbles: true }));
        }
        """
    )
    print("PASS: photo search self-test")


def verify_pwa_standalone_verification(driver, wait, base: str) -> None:
    """Simulate iOS standalone PWA; boot should persist notes_pwa_standalone_verified."""
    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {
            "source": """
            try {
              Object.defineProperty(navigator, 'standalone', {
                configurable: true,
                get() { return true; },
              });
            } catch (err) { /* best effort */ }
            const origMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : null;
            window.matchMedia = (query) => {
              if (String(query).includes('standalone')) {
                return {
                  matches: true,
                  media: query,
                  addListener() {},
                  removeListener() {},
                  addEventListener() {},
                  removeEventListener() {},
                  dispatchEvent() { return false; },
                };
              }
              if (origMatchMedia) return origMatchMedia(query);
              return {
                matches: false,
                media: query,
                addListener() {},
                removeListener() {},
                addEventListener() {},
                removeEventListener() {},
                dispatchEvent() { return false; },
              };
            };
            """,
        },
    )
    driver.execute_script("localStorage.removeItem('notes_pwa_standalone_verified');")
    driver.get(f"{base}/?nosync=1")
    wait.until(
        lambda d: d.execute_script(
            "return !!window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked();"
        )
    )
    verified = driver.execute_script(
        "return localStorage.getItem('notes_pwa_standalone_verified') || '';"
    )
    if not verified:
        raise AssertionError("notes_pwa_standalone_verified not set after standalone boot")
    print("PASS: PWA standalone verification flag set")


def set_offline(driver, offline: bool) -> None:
    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd(
        "Network.emulateNetworkConditions",
        {
            "offline": offline,
            "downloadThroughput": 0 if offline else -1,
            "uploadThroughput": 0 if offline else -1,
            "latency": 0 if offline else 0,
        },
    )


def verify_clear_app_caches(driver) -> None:
    """Settings → Refresh app cache clears SW registrations and Cache Storage."""
    seeded = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        if (typeof caches === 'undefined') return done(false);
        caches.open('deeperguard-test-cache')
          .then((cache) => cache.put('/notes-e2e-cache-probe', new Response('ok')))
          .then(() => done(true))
          .catch(() => done(false));
        """
    )
    if not seeded:
        raise AssertionError("could not seed Cache Storage for refresh test")
    driver.execute_script(
        """
        sessionStorage.setItem('notes_sw_reloaded', 'test');
        sessionStorage.setItem('notes_reloaded_build', 'test');
        sessionStorage.setItem('notes_pending_update_build', 'test');
        """
    )
    cleared = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        const run = async () => {
          if (typeof window.notesClearAppCaches !== 'function') return false;
          await window.notesClearAppCaches();
          if (sessionStorage.getItem('notes_sw_reloaded')) return false;
          if (sessionStorage.getItem('notes_reloaded_build')) return false;
          if (sessionStorage.getItem('notes_pending_update_build')) return false;
          if (typeof caches === 'undefined') return true;
          const keys = await caches.keys();
          return !keys.includes('deeperguard-test-cache');
        };
        run().then((value) => done(!!value)).catch(() => done(false));
        """
    )
    if not cleared:
        raise AssertionError("notesClearAppCaches did not clear test cache or session flags")
    print("PASS: refresh app cache clears offline storage")


def verify_lan_probe_despite_offline_flag(driver, wait) -> None:
    """iOS LAN-only Wi‑Fi: navigator.onLine=false but homelab /api/health still works."""
    driver.execute_script(
        """
        try {
          Object.defineProperty(navigator, 'onLine', {
            configurable: true,
            get() { return false; },
          });
        } catch (err) { /* best effort */ }
        """
    )
    offline = driver.execute_script("return navigator.onLine === false;")
    if not offline:
        raise AssertionError("could not simulate navigator.onLine=false")
    driver.execute_script("window.dispatchEvent(new Event('online'));")
    wait.until(
        lambda d: d.execute_script(
            "return typeof window.notesNetworkReachable === 'function' && window.notesNetworkReachable();"
        ),
        message="probeNetwork did not mark LAN reachable while navigator.onLine is false",
    )
    print("PASS: LAN health probe while navigator.onLine is false")


def verify_sync_on_lan_despite_offline_flag(driver, wait) -> None:
    """Encrypted sync should reach the server when LAN health probe succeeds."""
    ok = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        NotesStore.sync({ quiet: true })
          .then(() => done(true))
          .catch((err) => done(String(err && err.message ? err.message : err)));
        """
    )
    if ok is not True:
        raise AssertionError(f"sync failed while navigator.onLine is false ({ok!r})")
    print("PASS: vault sync on LAN while navigator.onLine is false")


def main() -> int:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="notes-offline-e2e-"))
    photo = make_labeled_photo(OUT_DIR / "offline-photo.jpg")
    heic = None
    try:
        heic = make_labeled_heic(OUT_DIR / "offline-photo.heic")
    except RuntimeError as err:
        print(f"WARN: skipping HEIC direct attach check ({err})")
    attach_txt = OUT_DIR / "direct-attach.txt"
    attach_txt.write_text("Direct single-file attach E2E\n", encoding="utf-8")
    port = free_port()
    server = start_server(tmp, port)
    base = f"http://127.0.0.1:{port}"
    driver = None
    failures = []
    try:
        driver = make_driver()
        wait = WebDriverWait(driver, 90)
        ocr_wait = WebDriverWait(driver, 60)
        unlock_app(driver, wait, base)
        try:
            verify_lan_probe_despite_offline_flag(driver, wait)
        except AssertionError as err:
            failures.append("lan probe offline flag")
            print(f"FAIL: {err}")
        try:
            verify_sync_on_lan_despite_offline_flag(driver, wait)
        except AssertionError as err:
            failures.append("lan sync offline flag")
            print(f"FAIL: {err}")
        create_text_note(driver, wait)
        driver.execute_script("return NotesStore.flush();")
        wait.until(lambda d: d.execute_script("return NotesStore.listNotes().length >= 1;"))
        try:
            attach_single_file_direct(driver, wait, NOTE_TITLE, attach_txt)
        except AssertionError as err:
            failures.append("direct single-file attach")
            print(f"FAIL: {err}")
        try:
            verify_session_bootstrap_without_cookie(driver)
        except AssertionError as err:
            failures.append("pwa session bootstrap")
            print(f"FAIL: {err}")
        if heic is not None:
            try:
                attach_image_direct_with_ocr(
                    driver,
                    wait,
                    ocr_wait,
                    NOTE_TITLE,
                    heic,
                    HEIC_TOKEN,
                    simulate_ios_offline=True,
                )
            except Exception as err:
                failures.append("heic direct attach ocr")
                print(f"FAIL: HEIC direct attach OCR ({err})")
        upload_photo(driver, wait, ocr_wait, photo, "Offline photo scan")

        try:
            verify_document_opens_in_preview(driver, wait, "Offline photo scan")
        except AssertionError as err:
            failures.append("document preview mode")
            print(f"FAIL: {err}")

        try:
            verify_find_in_ocr(driver, wait, IMAGE_TOKEN)
        except AssertionError as err:
            failures.append("find in OCR")
            print(f"FAIL: {err}")

        driver.execute_script(
                """
                const s = document.getElementById('search');
                s.value = arguments[0];
                s.dispatchEvent(new Event('input', { bubbles: true }));
                """,
            IMAGE_TOKEN,
        )
        time.sleep(0.6)
        image_matches = driver.execute_script(
            "return [...document.querySelectorAll('.note-item')].filter((r) => r.textContent.includes(arguments[0])).length;",
            IMAGE_TOKEN,
        )
        if not image_matches:
            failures.append("image search in note list")
            print("FAIL: uploaded image text is not searchable in the list")
        else:
            print(f"PASS: image OCR searchable ({image_matches} list row(s))")

        try:
            verify_stale_search_index_repair(driver, IMAGE_TOKEN)
        except AssertionError as err:
            failures.append("stale search index repair")
            print(f"FAIL: {err}")

        try:
            verify_all_device_tests(driver)
        except AssertionError as err:
            failures.append("all device tests")
            print(f"FAIL: {err}")

        try:
            verify_device_report_uploaded(tmp / "data")
        except AssertionError as err:
            failures.append("device report upload")
            print(f"FAIL: {err}")

        try:
            verify_note_action_buttons(driver, wait, "Offline photo scan", PASSWORD)
        except AssertionError as err:
            failures.append("note action buttons")
            print(f"FAIL: {err}")

        enable_remember_device(driver)
        salt = driver.execute_script("return localStorage.getItem('notes_kdf_salt') || '';")
        if not salt:
            failures.append("missing kdf_salt cache")
            print("FAIL: kdf_salt not cached after unlock")
        else:
            print("PASS: kdf_salt cached for offline unlock")

        driver.execute_script("sessionStorage.clear();")
        set_offline(driver, True)
        driver.get(f"{base}/?nosync=1")
        wait.until(lambda d: d.execute_script(
            "return !!document.body && document.body.classList.contains('locked');"
        ))
        print("PASS: vault locked after offline restart")
        # Remember-device keeps offline unlock possible; user must still unlock.
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        pw = wait.until(EC.presence_of_element_located((By.ID, "unlock-password")))
        pw.clear()
        pw.send_keys(PASSWORD)
        driver.find_element(By.ID, "unlock-submit").click()
        wait.until(lambda d: d.execute_script(
            "return !!window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked();"
        ))
        print("PASS: vault unlocked offline with remember-device salt after restart")

        verified = driver.execute_script(
            "return localStorage.getItem('notes_offline_unlock_verified') || '';"
        )
        if not verified:
            failures.append("offline unlock verification flag")
            print("FAIL: notes_offline_unlock_verified not set after offline unlock")
        else:
            print("PASS: offline unlock verification flag set")

        try:
            verify_pwa_standalone_verification(driver, wait, base)
        except AssertionError as err:
            failures.append("pwa standalone verification flag")
            print(f"FAIL: {err}")

        offline_class = driver.execute_script("return document.body.classList.contains('is-offline');")
        if not offline_class:
            print("WARN: body.is-offline not set yet (probe may still be running)")
        else:
            print("PASS: offline UI state active")

        rows = driver.execute_script(
            "return [...document.querySelectorAll('.note-item')].map((r) => r.textContent);"
        )
        if not any(NOTE_TITLE in row for row in rows):
            failures.append("offline note list")
            print(f"FAIL: text note missing offline. rows={rows[:3]}")
        else:
            print("PASS: text note visible offline")

        driver.execute_script(
            """
            const note = NotesStore.listNotes().find((n) => (n.content.title || '').includes(arguments[0]));
            if (!note) return false;
            const row = [...document.querySelectorAll('.note-item')].find((r) => r.dataset.id === note.uuid);
            if (row) row.click();
            return !!row;
            """,
            NOTE_TITLE,
        )
        wait.until(lambda d: d.find_element(By.ID, "note-body").is_displayed())
        body = driver.find_element(By.ID, "note-body").get_attribute("value") or ""
        if NOTE_BODY not in body:
            failures.append("offline note body")
            print(f"FAIL: note body not loaded offline ({body[:80]!r})")
        else:
            print("PASS: note body readable offline")

        driver.find_element(By.ID, "note-body").send_keys(" edited offline")
        time.sleep(0.5)
        edited = driver.find_element(By.ID, "note-body").get_attribute("value") or ""
        if "edited offline" not in edited:
            failures.append("offline edit")
            print("FAIL: could not edit note offline")
        else:
            print("PASS: note editable offline")

        try:
            verify_clear_app_caches(driver)
        except AssertionError as err:
            failures.append("refresh app cache clear")
            print(f"FAIL: {err}")

        driver.save_screenshot(str(OUT_DIR / "offline-vault.png"))
        print(f"screenshot: {OUT_DIR / 'offline-vault.png'}")

        if failures:
            print(f"\nFAILED: {failures}")
            return 1
        print("\nALL OFFLINE CHECKS PASS")
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
