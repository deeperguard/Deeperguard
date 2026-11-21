"""E2E: vCard import and export in the Contacts tab (docs/CONTACTS_SPEC.md sections 7 and 8).

Real browser, real server. Checks the preview and the result summary, that choosing files and the
preview make no request at all, that the import sends no plaintext (names, numbers) to the server,
that a dropped file works, that an empty file gives a message, that undo removes exactly the last
import, that HTML in a card is shown as text, keyboard use, phone width, and the export password step.

    python tests/e2e_contacts_import.py
"""
from __future__ import annotations

import tempfile
import time
from pathlib import Path

from e2e_contacts_sync import PASSWORD, contacts_action, free_port, open_contacts_menu, register, select_mode_on
from e2e_signup_autounlock import start_server

FIXTURES = Path(__file__).parent / "fixtures" / "contacts"
HOSTILE = (
    "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:<img src=x onerror=\"window.__xss=1\"> Mallory\r\n"
    "TEL:+31 6 5550 0001\r\nEND:VCARD\r\n"
)


def fixture(name: str) -> dict:
    return {"name": name, "mimeType": "text/vcard", "buffer": (FIXTURES / name).read_bytes()}


def names(page) -> list[str]:
    return page.eval_on_selector_all("#contacts-list .contacts-row-name", "els => els.map(e => e.textContent)")


def no_hscroll(page, where: str) -> None:
    over = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    assert over <= 0, f"{where}: horizontal overflow of {over}px"
    over = page.evaluate("() => { const d = document.getElementById('contacts-import-dialog'); return d.scrollWidth - d.clientWidth; }")
    assert over <= 0, f"{where}: import dialog overflows by {over}px"


def run_flow(page, width: int) -> None:
    where = f"{width}px"
    requests: list[tuple[str, str, str]] = []
    page.on("request", lambda r: requests.append((r.method, r.url, r.post_data or "")))

    page.click("#app-tab-contacts")
    page.wait_for_selector("#contacts-pane:not([hidden])")

    # Keyboard: the Import button opens the dialog, focus lands inside it.
    open_contacts_menu(page)
    page.focus("#btn-contacts-import")
    page.keyboard.press("Enter")
    page.wait_for_selector("#contacts-import-dialog:not([hidden])")
    # dialog-a11y.js moves focus into the dialog in a 0 ms timer after it opens.
    page.wait_for_function("() => document.getElementById('contacts-import-dialog').contains(document.activeElement)", timeout=2000)
    assert page.get_attribute("#contacts-import-dialog", "aria-labelledby") == "contacts-import-title"
    no_hscroll(page, f"{where} dialog")

    # An empty file and a file that is not a contact file: clear messages, nothing to import.
    page.set_input_files("#contacts-import-file", files=[{"name": "empty.vcf", "mimeType": "text/vcard", "buffer": b""}])
    page.wait_for_selector("#contacts-import-problems li")
    assert "empty.vcf: this file is empty." in page.inner_text("#contacts-import-problems")
    assert "empty.vcf: this file is empty." in page.inner_text("#contacts-import-error")
    assert page.is_disabled("#contacts-import-run")

    # Several files at once: an Apple card, the cut-off Outlook file, and a text file.
    before = len(requests)
    page.set_input_files("#contacts-import-file", files=[
        fixture("apple-3.0.vcf"),
        fixture("outlook-android-2.1.vcf"),
        {"name": "notes.txt", "mimeType": "text/plain", "buffer": b"hello"},
    ])
    page.wait_for_selector("#contacts-import-preview:not([hidden])")
    page.wait_for_function("document.querySelectorAll('#contacts-import-list li').length === 3")
    summary = page.inner_text("#contacts-import-summary")
    assert "Found 3 contacts in 3 files" in summary, summary
    assert "problems found" in summary and "1 files not read" not in summary, summary
    problems = page.inner_text("#contacts-import-problems")
    assert "notes.txt: This is not a contact file" in problems, problems
    assert "outlook-android-2.1.vcf: card 2 was not closed" in problems, problems
    files = page.inner_text("#contacts-import-files")
    assert "vCard 3.0, Apple, utf-8" in files and "vCard 2.1" in files, files
    assert page.inner_text("#contacts-import-run") == "Import 3 contacts"
    # Reading and previewing must not touch the network at all.
    assert len(requests) == before, requests[before:]

    # Leave one contact out with its checkbox.
    page.uncheck("#contacts-import-list li:nth-child(3) input")
    assert page.inner_text("#contacts-import-run") == "Import 2 contacts"
    page.check("#contacts-import-list li:nth-child(3) input")

    start = len(requests)
    page.click("#contacts-import-run")
    page.wait_for_selector("#contacts-import-result:not([hidden])")
    result = page.inner_text("#contacts-import-result-summary")
    assert "Imported 3 new contacts" in result and "0 not imported" in result and "2 photos stored" in result, result
    assert "They were not uploaded." in page.inner_text("#contacts-import-result")
    page.wait_for_function("() => document.querySelectorAll('#contacts-list .contacts-row-name').length === 3")
    assert len(names(page)) == 3, names(page)
    # The sync that follows carries ciphertext only: no name or number in any request.
    time.sleep(2.5)
    sent = "".join(body for method, url, body in requests[start:] if method != "GET")
    for secret in ("Sanne", "Visser", "Müller", "M\\u00fcller", "Koch", "Wilhelminastraat", "5550"):
        assert secret not in sent, f"{secret} was sent to the server"
    assert not any("vcard" in url.lower() or "import" in url.lower() for _, url, _ in requests[before:]), "unexpected upload URL"
    assert page.is_visible("#contacts-import-undo")

    # Undo removes exactly those three contacts.
    page.click("#contacts-import-undo")
    page.wait_for_function("document.querySelectorAll('#contacts-list .contacts-row-name').length === 0")
    assert "Import undone: 3 contacts removed." in page.inner_text("#contacts-import-result-summary")
    page.click("#contacts-import-close")
    page.wait_for_selector("#contacts-import-dialog", state="hidden")
    assert page.evaluate("document.activeElement.id") == ("btn-contacts-more" if width < 1000 else "btn-contacts-import")

    # Two imports: the undo of the second leaves the first alone. Drop a file this time.
    contacts_action(page, "#btn-contacts-import")
    page.set_input_files("#contacts-import-file", files=[fixture("nextcloud-4.0.vcf")])
    page.wait_for_selector("#contacts-import-run:not([hidden])")
    page.click("#contacts-import-run")
    page.wait_for_selector("#contacts-import-result:not([hidden])")
    page.click("#contacts-import-close")
    page.wait_for_function("document.querySelectorAll('#contacts-list .contacts-row-name').length === 1")
    contacts_action(page, "#btn-contacts-import")
    page.evaluate(
        """(text) => {
          const dt = new DataTransfer();
          dt.items.add(new File([text], 'dropped.vcf', { type: 'text/vcard' }));
          document.getElementById('contacts-import-dialog')
            .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        }""",
        HOSTILE,
    )
    page.wait_for_selector("#contacts-import-run:not([hidden])")
    assert page.evaluate("window.__xss") is None
    assert page.query_selector("#contacts-import-dialog img") is None
    assert "<img src=x" in page.inner_text("#contacts-import-list")
    page.click("#contacts-import-run")
    page.wait_for_function("document.querySelectorAll('#contacts-list .contacts-row-name').length === 2")
    # Importing the same file again leaves the existing contact out by default (same phone).
    page.click("#contacts-import-close")
    contacts_action(page, "#btn-contacts-import")
    page.set_input_files("#contacts-import-file", files=[fixture("nextcloud-4.0.vcf")])
    page.wait_for_selector("#contacts-import-preview:not([hidden])")
    assert "1 look like contacts you already have" in page.inner_text("#contacts-import-summary")
    assert page.is_disabled("#contacts-import-run")
    # The duplicate is shown with its reason before anything is saved; Keep both adds it, undo removes it again.
    assert page.is_visible("#contacts-import-dups")
    assert "same contact imported before as Lotte de Boer (in your vault)" in page.inner_text("#contacts-import-dup-list")
    page.check("#contacts-import-dup-all-both")
    assert page.inner_text("#contacts-import-run").strip() == "Import 1 contact"
    page.click("#contacts-import-run")
    page.wait_for_function("() => document.querySelectorAll('#contacts-list .contacts-row-name').length === 3")
    assert "Imported 1 new contact" in page.inner_text("#contacts-import-result-summary")
    page.click("#contacts-import-undo")
    page.wait_for_function("() => document.querySelectorAll('#contacts-list .contacts-row-name').length === 2")
    page.click("#contacts-import-close")

    # Merge: the same person with the number written differently, one new email and one new number. The existing
    # values stay, the new ones are added, no contact is added; undo takes the additions out again.
    merge_card = (
        "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Lotte de Boer\r\nTEL:0031 6 2233 4455\r\nTEL:06 9999 8888\r\n"
        "EMAIL:lotte.prive@example.nl\r\nEND:VCARD\r\n"
    )

    def merge_import() -> None:
        page.click("#btn-contacts-import")
        page.set_input_files("#contacts-import-file", files=[{"name": "again.vcf", "mimeType": "text/vcard", "buffer": merge_card.encode()}])
        page.wait_for_selector("#contacts-import-preview:not([hidden])")
        assert "1 look like contacts you already have" in page.inner_text("#contacts-import-summary")
        page.select_option("#contacts-import-dup-list select", "merge")
        page.click("#contacts-import-run")
        page.wait_for_selector("#contacts-import-result:not([hidden])")
        assert "1 merged into other contacts" in page.inner_text("#contacts-import-result-summary")
        assert len(names(page)) == 2

    def lotte_detail() -> str:
        if not page.is_visible("#contacts-list") and page.is_visible("#contacts-detail .contacts-back"):
            page.click("#contacts-detail .contacts-back")
        page.click("#contacts-list .contacts-row-name >> text=Lotte de Boer")
        return page.inner_text("#contacts-detail")

    merge_import()
    page.click("#contacts-import-undo")
    page.wait_for_function("() => document.getElementById('contacts-import-result-summary').textContent.includes('1 merge undone')")
    page.click("#contacts-import-close")
    assert "lotte.prive@example.nl" not in lotte_detail()
    merge_import()
    page.click("#contacts-import-close")
    detail = lotte_detail()
    assert "lotte@deboer.example" in detail and "lotte.prive@example.nl" in detail and "06 9999 8888" in detail, detail
    assert detail.count("22334455") + detail.count("2233 4455") == 1, detail
    if not page.is_visible("#contacts-list"):
        page.click("#contacts-detail .contacts-back")
    assert page.evaluate("window.__xss") is None
    no_hscroll(page, f"{where} list")

    # Export: a wrong password makes no file; the right one downloads a vCard that reads back.
    contacts_action(page, "#btn-contacts-export")
    page.wait_for_selector("#confirm-password-wrap:not([hidden])")
    page.fill("#confirm-password", "not the password")
    page.click("#confirm-ok")
    page.wait_for_selector("#confirm-password-error:not([hidden])")
    assert "Wrong password. Nothing was exported." in page.inner_text("#confirm-password-error")
    assert page.input_value("#confirm-password") == ""
    page.fill("#confirm-password", PASSWORD)
    with page.expect_download() as dl:
        page.click("#confirm-ok")
    path = dl.value.path()
    assert dl.value.suggested_filename.startswith("deeperguard-contacts-")
    raw = Path(path).read_bytes()
    text = raw.decode("utf-8")
    assert text.count("BEGIN:VCARD") == 2 and "VERSION:3.0" in text and "FN:Lotte de Boer" in text, text
    assert b"\r\nTEL;TYPE=CELL,PREF:" in raw, raw

    # CSV: same password step, the format is chosen in the dialog; the file has a BOM, the Google header and no vCard.
    page.set_default_timeout(10000)
    contacts_action(page, "#btn-contacts-export")
    page.wait_for_selector("#confirm-password-wrap:not([hidden])")
    page.select_option("#confirm-choice", "csv")
    assert "CSV loses some fields" in page.inner_text("#confirm-choice-note")
    assert page.inner_text("#confirm-ok").strip() == "Export unencrypted CSV"
    page.fill("#confirm-password", PASSWORD)
    with page.expect_download() as dl:
        page.click("#confirm-ok")
    assert dl.value.suggested_filename.startswith("deeperguard-contacts-") and dl.value.suggested_filename.endswith(".csv")
    csv_raw = Path(dl.value.path()).read_bytes()
    assert csv_raw.startswith(b"\xef\xbb\xbfName,First Name,"), csv_raw[:60]
    csv_text = csv_raw.decode("utf-8")
    assert b"BEGIN:VCARD" not in csv_raw and "Lotte" in csv_text and "\r\n" in csv_text, csv_text
    page.wait_for_selector("#confirm-dialog", state="hidden")

    # Share as vCard from the detail exports only that contact, after the same password step.
    page.locator("#contacts-list .contacts-row-open", has_text="Lotte de Boer").click()
    page.wait_for_selector('[aria-label="Share Lotte de Boer as vCard"]')
    page.focus('[aria-label="Share Lotte de Boer as vCard"]')
    page.keyboard.press("Enter")
    page.wait_for_selector("#confirm-password-wrap:not([hidden])")
    assert "1 contact will be exported" in page.inner_text("#confirm-dialog")
    page.fill("#confirm-password", PASSWORD)
    with page.expect_download() as dl:
        page.click("#confirm-ok")
    assert dl.value.suggested_filename == "Lotte de Boer.vcf", dl.value.suggested_filename
    one = Path(dl.value.path()).read_text("utf-8")
    assert one.count("BEGIN:VCARD") == 1 and "FN:Lotte de Boer" in one, one
    no_hscroll(page, f"{where} detail")
    if width < 900:  # the phone layout shows the detail instead of the list
        page.click('[aria-label="Back to contacts"]')

    # Export with a search filter and no selection: only the contacts shown are written, and the dialog says so.
    page.fill("#contacts-search", "Lotte")
    contacts_action(page, "#btn-contacts-export")
    page.wait_for_selector("#confirm-password-wrap:not([hidden])")
    assert "1 contact will be exported" in page.inner_text("#confirm-dialog")
    assert "Only the contacts shown in the list are exported" in page.inner_text("#confirm-dialog")
    page.fill("#confirm-password", PASSWORD)
    with page.expect_download() as dl:
        page.click("#confirm-ok")
    shown = Path(dl.value.path()).read_text("utf-8")
    assert shown.count("BEGIN:VCARD") == 1 and "FN:Lotte de Boer" in shown, shown
    page.wait_for_selector("#confirm-dialog", state="hidden")
    page.fill("#contacts-search", "")

    # Selection mode: tick one contact and Export writes only that one; Done removes the ticks.
    assert page.locator("[data-contact-tick]").count() == 0
    contacts_action(page, "#btn-contacts-select")
    assert select_mode_on(page)
    assert page.locator("[data-contact-tick]").count() == 2
    page.check('[aria-label="Select Lotte de Boer"]')
    assert page.inner_text("#btn-contacts-export").strip() == "Export 1 selected"
    no_hscroll(page, f"{where} selection")
    contacts_action(page, "#btn-contacts-export")
    page.wait_for_selector("#confirm-password-wrap:not([hidden])")
    assert "1 contact will be exported" in page.inner_text("#confirm-dialog")
    page.fill("#confirm-password", PASSWORD)
    with page.expect_download() as dl:
        page.click("#confirm-ok")
    assert dl.value.suggested_filename.startswith("deeperguard-contacts-")
    picked = Path(dl.value.path()).read_text("utf-8")
    assert picked.count("BEGIN:VCARD") == 1 and "FN:Lotte de Boer" in picked, picked
    contacts_action(page, "#btn-contacts-select")
    assert page.locator("[data-contact-tick]").count() == 0
    assert page.inner_text("#btn-contacts-export").strip() == "Export"
    contacts_action(page, "#btn-contacts-select")  # left on, so lock must clear it
    page.check('[aria-label="Select Lotte de Boer"]')

    # Lock: nothing of the contacts stays in the page.
    page.click("#btn-contacts-lock")
    page.wait_for_function("document.querySelectorAll('#contacts-list .contacts-row-name').length === 0")
    assert page.evaluate("document.getElementById('contacts-import-dialog').hidden")
    assert page.inner_text("#btn-contacts-export").strip() == "Export"
    assert not select_mode_on(page)
    stored = page.evaluate("JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
    assert "Lotte" not in stored and "Mallory" not in stored, stored


def open_import(page) -> None:
    contacts_action(page, "#btn-contacts-import")
    page.wait_for_selector("#contacts-import-dialog:not([hidden])")


def wait_quiet(requests: list[str], seconds: float = 3.0) -> None:
    """Wait until the sync that follows an import has finished: no new request for `seconds`."""
    seen, since = len(requests), time.time()
    while time.time() - since < seconds:
        time.sleep(0.25)
        if len(requests) != seen:
            seen, since = len(requests), time.time()


def run_format_flow(page) -> None:
    """CSV through the mapping step, content sniffing for a wrong extension, an unsupported file, and lock."""
    page.set_default_timeout(15000)
    requests: list[str] = []
    # The app itself polls GET /api/account in the background; every other request counts.
    page.on("request", lambda r: None if r.method == "GET" and r.url.endswith("/api/account") else requests.append(f"{r.method} {r.url}"))
    page.click("#app-tab-contacts")
    page.wait_for_selector("#contacts-pane:not([hidden])")

    # 1. A generic CSV: semicolons, Windows-1252, a quoted newline, doubled quotes, a cell starting with "=".
    raw = (FIXTURES / "csv-6.3.3-semicolon-cp1252.csv").read_bytes()
    assert b"\xdc" in raw, "fixture must hold Windows-1252 bytes"
    open_import(page)
    before = len(requests)
    page.set_input_files("#contacts-import-file", files=[{"name": "people.csv", "mimeType": "text/csv", "buffer": raw}])
    page.wait_for_selector("#contacts-import-mapping:not([hidden])")
    assert page.is_hidden("#contacts-import-preview") and page.is_hidden("#contacts-import-run")
    headers = page.eval_on_selector_all("#contacts-import-map-body th", "els => els.map(e => e.textContent)")
    assert headers == ["Voornaam", "Achternaam", "Mobiel", "E-mail", "Adres", "Opmerking"], headers
    suggested = page.eval_on_selector_all("#contacts-import-map-body select", "els => els.map(e => e.value)")
    assert suggested == ["given", "family", "phone:mobile", "email:other", "street", "note"], suggested
    assert page.eval_on_selector("#contacts-import-map-0", "e => e.options[e.selectedIndex].textContent") == "Name: given"
    assert page.eval_on_selector("#contacts-import-map-0", "e => [...e.options].some(o => o.textContent === 'Keep as other field')")
    assert page.get_attribute("#contacts-import-map-0", "id") == page.eval_on_selector(
        "#contacts-import-map-body tr:first-child label", "l => l.htmlFor")
    rows = page.eval_on_selector_all(
        "#contacts-import-map-body tr", "trs => trs.map(tr => [...tr.querySelectorAll('.contacts-map-sample')].map(d => d.textContent))")
    assert rows[0] == ["Ünal", "Fieke"], rows[0]  # decoded from Windows-1252, as text
    assert rows[2] == ["06-12345678", "=+31 6 11"], rows[2]  # a leading "=" stays text
    assert rows[4] == ["Kerkstraat 1\n3511 AB Utrecht"], rows[4]  # the quoted newline survived
    assert rows[5] == ['zei: "bel mij"'], rows[5]
    assert page.query_selector("#contacts-import-map-body img, #contacts-import-map-body script") is None

    # Two columns on one single-value target are refused and Continue stays disabled.
    page.select_option("#contacts-import-map-1", "given")
    assert "Two columns are mapped" in page.inner_text("#contacts-import-map-error")
    assert page.is_disabled("#contacts-import-map-confirm")
    page.select_option("#contacts-import-map-1", "family")
    assert page.is_hidden("#contacts-import-map-error") and page.is_enabled("#contacts-import-map-confirm")
    # Nothing that identifies a contact left: refused too.
    page.select_option("#contacts-import-map-0", "extra")
    page.select_option("#contacts-import-map-1", "extra")
    page.select_option("#contacts-import-map-2", "extra")
    page.select_option("#contacts-import-map-3", "extra")
    assert "at least one column" in page.inner_text("#contacts-import-map-error")
    assert page.is_disabled("#contacts-import-map-confirm")
    page.select_option("#contacts-import-map-0", "given")
    page.select_option("#contacts-import-map-1", "family")
    page.select_option("#contacts-import-map-2", "phone:mobile")
    page.select_option("#contacts-import-map-3", "email:other")
    page.click("#contacts-import-map-confirm")
    page.wait_for_selector("#contacts-import-preview:not([hidden])")
    assert page.is_hidden("#contacts-import-mapping")
    assert "Found 2 contacts in 1 file" in page.inner_text("#contacts-import-summary"), page.inner_text("#contacts-import-summary")
    assert page.inner_text("#contacts-import-files").startswith("people.csv: CSV, columns mapped by you, windows-1252")
    assert page.eval_on_selector_all("#contacts-import-list li", "els => els.map(e => e.textContent.trim())") == ["Ünal Çelik", "Fieke Bos"]
    assert page.inner_text("#contacts-import-run") == "Import 2 contacts"
    # Choosing, parsing, mapping and previewing sent nothing at all.
    assert requests[before:] == [], requests[before:]

    page.click("#contacts-import-run")
    page.wait_for_selector("#contacts-import-result:not([hidden])")
    assert "Imported 2 new contacts" in page.inner_text("#contacts-import-result-summary")
    page.wait_for_function("document.querySelectorAll('#contacts-list .contacts-row-name').length === 2")
    assert sorted(names(page)) == ["Fieke Bos", "Ünal Çelik"], names(page)
    page.click("#contacts-import-close")
    page.locator("#contacts-list .contacts-row-open", has_text="Ünal Çelik").click()
    page.wait_for_selector("#contacts-detail:not([hidden])")
    detail = page.inner_text("#contacts-detail")
    assert "Kerkstraat 1" in detail and "3511 AB Utrecht" in detail and "unal@example.nl" in detail and "bel mij" in detail, detail

    # 2. A vCard saved as .txt is recognised by its content and goes straight to the preview.
    wait_quiet(requests)  # the import's own sync is not what the checks below are about
    open_import(page)
    before = len(requests)
    page.set_input_files("#contacts-import-file", files=[{"name": "contacts.txt", "mimeType": "text/plain", "buffer": (FIXTURES / "apple-3.0.vcf").read_bytes()}])
    page.wait_for_selector("#contacts-import-preview:not([hidden])")
    assert page.is_hidden("#contacts-import-mapping")
    assert "vCard 3.0" in page.inner_text("#contacts-import-files")
    assert "Found 1 contact in 1 file" in page.inner_text("#contacts-import-summary"), page.inner_text("#contacts-import-summary")
    assert requests[before:] == [], requests[before:]
    page.click("#contacts-import-close")

    # 3. An unsupported file named like a CSV: a message that lists what is supported, shown as text.
    open_import(page)
    before = len(requests)
    page.set_input_files("#contacts-import-file", files=[{"name": "list.csv", "mimeType": "text/csv", "buffer": b"<b>just some words</b>\nno columns here\n"}])
    page.wait_for_selector("#contacts-import-error:not([hidden])")
    message = page.inner_text("#contacts-import-error")
    for word in ("vCard", "CSV", "LDIF", "jCard"):
        assert word in message, message
    assert "list.csv:" in message and "<b>" not in message
    assert page.query_selector("#contacts-import-dialog b") is None
    assert page.is_hidden("#contacts-import-mapping") and page.is_disabled("#contacts-import-run")
    assert requests[before:] == [], requests[before:]

    # Lock while the mapping step is open: the parsed rows are gone from the page.
    page.set_input_files("#contacts-import-file", files=[{"name": "people.csv", "mimeType": "text/csv", "buffer": raw}])
    page.wait_for_selector("#contacts-import-mapping:not([hidden])")
    assert page.locator("#contacts-import-map-body tr").count() == 6
    # The dialog's backdrop covers the lock button, so lock the way the auto-lock does: through the same handler.
    page.evaluate("document.getElementById('btn-contacts-lock').click()")
    page.wait_for_function("() => document.getElementById('contacts-import-dialog').hidden")
    assert page.locator("#contacts-import-map-body tr").count() == 0
    stored = page.evaluate("JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href])")
    assert "Kerkstraat" not in stored and "Çelik" not in stored and "unal" not in stored, stored


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-contacts-import-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for width, height in ((390, 844), (1280, 800)):
                context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 900, accept_downloads=True)
                page = context.new_page()
                register(page, base, f"contacts-import-{width}-{int(time.time())}@home.local")
                run_flow(page, width)
                context.close()
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()
            register(page, base, f"contacts-formats-{int(time.time())}@home.local")
            run_format_flow(page)
            context.close()
            browser.close()
        print("ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
