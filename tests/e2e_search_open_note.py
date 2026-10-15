"""End-to-end: open a note from search results in the desktop split view.

Boots a throwaway Deeperguard instance at a desktop window size, uploads two
digital PDFs on one note (the searched word only in the second file) and one
PDF on another note, types the word in the sidebar search box and clicks a
result. The note on the right must still list its attachments, the inline
preview must open on the file that contains the word with a visible highlight
count (`N highlights in this PDF`) and a stepper, and that file's row must carry
an `N highlights in this file` badge. The note-list count stays a note count.

`tests/test_e2e_search_open_note.py` wraps this for `unittest discover`
(`E2E_SEARCH=1`). Run it directly when Chrome/Chromium and selenium are
installed (`E2E_CHROME` / `E2E_CHROMEDRIVER` override the binaries):

    python tests/e2e_search_open_note.py
"""
from __future__ import annotations

import base64
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_search_highlight import (  # noqa: E402
    INVOICE_LINES,
    free_port,
    make_text_pdf,
    start_server,
    unlock_app,
)

QUERY = "Rodriguez"
OUT_DIR = Path(os.environ.get("E2E_OUT", "/tmp/notes-e2e"))


def chrome_binary() -> str | None:
    env = os.environ.get("E2E_CHROME")
    if env and Path(env).exists():
        return env
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        found = shutil.which(name)
        if found:
            return found
    return None


def make_driver(width: int = 1400, height: int = 900):
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service

    opts = Options()
    binary = chrome_binary()
    if binary:
        opts.binary_location = binary
    for flag in (
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        f"--window-size={width},{height}",
    ):
        opts.add_argument(flag)
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    chromedriver = os.environ.get("E2E_CHROMEDRIVER") or shutil.which("chromedriver")
    service = Service(chromedriver) if chromedriver else None
    driver = webdriver.Chrome(service=service, options=opts) if service else webdriver.Chrome(options=opts)
    driver.set_script_timeout(int(os.environ.get("E2E_SCRIPT_TIMEOUT", "180")))
    return driver


def new_note(driver, title: str, body: str = "") -> str:
    return driver.execute_script(
        """
        const id = NotesStore.newUuid();
        NotesStore.upsert(id, { ...NotesStore.defaultNote(), title: arguments[0], content: arguments[1], attachments: [] });
        return id;
        """,
        title,
        body,
    )


def add_pdf(driver, note_id: str, path: Path, name: str) -> dict:
    """Attach a PDF through the encrypted store and index it on the device."""
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    result = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const raw = atob(arguments[0]);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
            const file = new File([bytes], arguments[1], { type: 'application/pdf' });
            const noteId = arguments[2];
            const attId = await NotesStore.addAttachment(noteId, file, { displayName: arguments[1] });
            const ocr = await NotesOcr.extractFromFile(file, null, attId);
            NotesStore.setAttachmentOcr(attId, ocr.text || '', ocr.method || 'client', Array.isArray(ocr.boxes) ? ocr.boxes : []);
            NotesStore.refreshNoteSearchText(noteId);
            done({ ok: true, attId, textLen: String(ocr.text || '').length });
          } catch (err) {
            done({ ok: false, error: err.message || String(err) });
          }
        })();
        """,
        payload,
        name,
        note_id,
    )
    if not result or not result.get("ok"):
        raise RuntimeError(result.get("error") if result else "attachment failed")
    if not result.get("textLen"):
        raise RuntimeError(f"no text extracted from {name}")
    return result


def set_search(driver, query: str) -> None:
    driver.execute_script(
        """
        const s = document.getElementById('search');
        s.value = arguments[0];
        s.dispatchEvent(new Event('input', { bubbles: true }));
        """,
        query,
    )


def click_row(driver, title: str) -> bool:
    return driver.execute_script(
        """
        const rows = [...document.querySelectorAll('.note-item')];
        const row = rows.find((r) => r.textContent.includes(arguments[0]));
        if (!row) return false;
        row.click();
        return true;
        """,
        title,
    )


def editor_state(driver) -> dict:
    return driver.execute_script(
        """
        const inline = document.getElementById('doc-inline');
        const stage = inline ? inline.querySelector('.doc-inline-stage') : null;
        const stageAtt = stage?.dataset?.stage || null;
        const stageItem = stageAtt ? NotesStore.get(stageAtt) : null;
        const rows = [...document.querySelectorAll('#attachment-list .attachment-item')].map((row) => ({
          name: row.querySelector('.attachment-filename')?.textContent || '',
          hit: row.classList.contains('is-search-hit'),
          badge: row.querySelector('.attachment-hit-badge')?.textContent || '',
        }));
        const current = document.querySelector('#doc-inline .doc-search-hit-current');
        const currentRect = current ? current.getBoundingClientRect() : null;
        return {
          title: document.getElementById('note-title')?.value || document.querySelector('#editor .title, #title')?.value || '',
          inlineHidden: inline ? inline.hidden : null,
          stageFile: stageItem ? stageItem.content.filename : null,
          painted: !!stage && stage.classList.contains('is-painted'),
          hits: document.querySelectorAll('#doc-inline .doc-search-hit').length,
          banner: document.querySelector('#doc-inline .doc-hit-note .doc-hit-note-label')?.textContent || '',
          counter: document.querySelector('#doc-inline .doc-hit-note [data-doc-hit-count]')?.textContent || '',
          hasStepper: !!document.querySelector('#doc-inline .doc-hit-note [data-doc-hit-nav="next"]'),
          currentOnScreen: !!currentRect && currentRect.top >= 0 && currentRect.bottom <= window.innerHeight,
          rows,
          listCount: document.querySelector('.notes-count, .list-count, #notes-count')?.textContent || '',
          thumbs: [...document.querySelectorAll('#doc-inline .doc-thumb-meta')].map((el) => el.textContent.trim()),
        };
        """
    )


def wait_for(driver, predicate, timeout: float = 60.0, step: float = 0.5):
    deadline = time.time() + timeout
    state = None
    while time.time() < deadline:
        state = editor_state(driver)
        if predicate(state):
            return state
        time.sleep(step)
    return state


def main() -> int:
    from selenium.webdriver.support.ui import WebDriverWait

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="notes-e2e-open-"))
    port = free_port()
    server = start_server(tmp, port)
    base = f"http://127.0.0.1:{port}"
    driver = None
    failures: list[str] = []
    try:
        driver = make_driver()
        wait = WebDriverWait(driver, 240)
        unlock_app(driver, wait, base)

        cover = make_text_pdf(OUT_DIR / "open-cover.pdf", [[
            (60, 760, 18, "Begeleidende brief"),
            (60, 700, 12, "Zie bijlage voor de factuur"),
        ]])
        invoice = make_text_pdf(OUT_DIR / "open-invoice.pdf", [INVOICE_LINES + [
            (60, 440, 12, "Contacto: Irene Rodriguez"),
            (60, 410, 12, "Rodriguez y asociados"),
        ]])
        single = make_text_pdf(OUT_DIR / "open-single.pdf", [INVOICE_LINES])

        dossier = new_note(driver, "Dossier wasmachine")
        add_pdf(driver, dossier, cover, "Brief.pdf")
        add_pdf(driver, dossier, invoice, "Factuur.pdf")
        other = new_note(driver, "Garantie")
        add_pdf(driver, other, single, "Garantie-factuur.pdf")
        new_note(driver, "Notitie", "Gesproken met Irene Rodriguez over de levering.")

        driver.execute_script("document.getElementById('btn-back')?.click();")
        time.sleep(0.5)
        set_search(driver, QUERY)
        time.sleep(1.5)
        rows = driver.execute_script(
            "return [...document.querySelectorAll('.note-item')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim());"
        )
        print(f"results for {QUERY!r}: {rows}")
        if not any("Dossier" in r for r in rows):
            failures.append("search did not list the note whose second file contains the word")

        # Case 1: two files, the word only in the second one.
        if not click_row(driver, "Dossier"):
            failures.append("could not click the Dossier row")
        state = wait_for(driver, lambda s: s["painted"] and s["banner"] and s["rows"], timeout=90)
        driver.save_screenshot(str(OUT_DIR / "open-note-dossier.png"))
        print(f"dossier: {state}")
        if state["inlineHidden"]:
            failures.append("inline preview hidden after opening a matched note")
        if state["stageFile"] != "Factuur.pdf":
            failures.append(f"preview opened on {state['stageFile']!r}, expected the file that contains the word")
        if not state["hits"]:
            failures.append("no highlight painted on the matched PDF")
        if not state["banner"].startswith("3 highlights in this PDF"):
            failures.append(f"banner {state['banner']!r} does not say how often the word occurs")
        if not state["hasStepper"] or state["counter"] != "1/3":
            failures.append(f"stepper missing or wrong: {state['counter']!r}")
        if not state["currentOnScreen"]:
            failures.append("first hit is not scrolled into view")
        names = [r["name"] for r in state["rows"]]
        if sorted(names) != ["Brief.pdf", "Factuur.pdf"]:
            failures.append(f"attachment rows {names} — both files must stay listed")
        by_name = {r["name"]: r for r in state["rows"]}
        if by_name.get("Factuur.pdf", {}).get("badge") != "3 highlights in this file":
            failures.append(f"Factuur.pdf row badge: {by_name.get('Factuur.pdf')!r}")
        if by_name.get("Brief.pdf", {}).get("badge"):
            failures.append("Brief.pdf has no hits and must not carry a badge")
        if not any("Brief.pdf" in t for t in state["thumbs"]):
            failures.append(f"the other file should remain as a thumbnail: {state['thumbs']}")

        # Stepper moves to the next hit and the counter follows.
        driver.execute_script("document.querySelector('#doc-inline [data-doc-hit-nav=\"next\"]')?.click();")
        time.sleep(0.8)
        stepped = editor_state(driver)
        if stepped["counter"] != "2/3":
            failures.append(f"stepper did not advance: {stepped['counter']!r}")

        # Case 2: a single-file note; its one file leads and is badged.
        if not click_row(driver, "Garantie"):
            failures.append("could not click the Garantie row")
        state = wait_for(driver, lambda s: s["painted"] and s["banner"] and s["rows"], timeout=90)
        driver.save_screenshot(str(OUT_DIR / "open-note-garantie.png"))
        print(f"garantie: {state}")
        if state["stageFile"] != "Garantie-factuur.pdf" or not state["hits"]:
            failures.append("single-file note did not open on its PDF with a highlight")
        if not state["banner"].startswith("1 highlight in this PDF"):
            failures.append(f"single-file banner: {state['banner']!r}")
        if not state["rows"] or state["rows"][0]["badge"] != "1 highlight in this file":
            failures.append(f"single-file row badge: {state['rows']!r}")

        # Case 3: a body-only note: no document banner, no badge, no crash.
        if not click_row(driver, "Notitie"):
            failures.append("could not click the Notitie row")
        time.sleep(1.5)
        state = editor_state(driver)
        if state["rows"] or state["banner"]:
            failures.append(f"body-only note shows document chrome: {state}")

        for entry in driver.get_log("browser"):
            if entry["level"] == "SEVERE" and "favicon" not in entry["message"]:
                print(f"console SEVERE: {entry['message'][:240]}")
                if "Maximum call stack" in entry["message"]:
                    failures.append("stack overflow in the page")

        if failures:
            print("\nFAILED:")
            for item in failures:
                print(f"  - {item}")
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
