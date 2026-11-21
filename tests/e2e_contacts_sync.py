"""E2E: a contact created in one browser session shows up in a second session of the same account.

The server only sees ciphertext: the test also reads the stored row from the database file and
checks that no name or number appears in it.

    python tests/e2e_contacts_sync.py
"""
from __future__ import annotations

import json
import socket
import sqlite3
import tempfile
import time
from pathlib import Path

from e2e_recovery_key_step import complete_recovery_key_step
from e2e_signup_autounlock import start_server

PASSWORD = "e2e-contacts-sync-12chars"
UNLOCKED = """() => location.pathname === '/app'
  && !!(window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked())
  && !!(NotesStore.isKeyVerified && NotesStore.isKeyVerified())"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def open_contacts_menu(page) -> None:
    """Below 1000px the Import / Select / Export / Find duplicates buttons sit in the "more" menu."""
    if page.is_visible("#btn-contacts-more") and page.get_attribute("#btn-contacts-more", "aria-expanded") != "true":
        page.click("#btn-contacts-more")
        page.wait_for_selector("#contacts-more-menu.is-open")


def contacts_action(page, selector: str) -> None:
    open_contacts_menu(page)
    page.click(selector)


def select_mode_on(page) -> bool:
    """The Select button is aria-pressed as a toolbar button and aria-checked as a menu item."""
    attr = "aria-checked" if page.get_attribute("#btn-contacts-select", "role") else "aria-pressed"
    return page.get_attribute("#btn-contacts-select", attr) == "true"


def register(page, base: str, email: str) -> None:
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
    page.wait_for_function(UNLOCKED, timeout=120000)
    complete_recovery_key_step(page)


def login(page, base: str, email: str) -> None:
    page.goto(f"{base}/login", wait_until="domcontentloaded")
    page.wait_for_selector('#login-form [name="email"]')
    page.fill('#login-form [name="email"]', email)
    page.fill("#login-password", PASSWORD)
    with page.expect_navigation(wait_until="domcontentloaded", timeout=90000):
        page.click("#login-submit")
    page.wait_for_function(UNLOCKED, timeout=120000)


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-contacts-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        email = f"contacts-{int(time.time())}@home.local"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            first = browser.new_context().new_page()
            register(first, base, email)

            made = first.evaluate(
                """async () => {
                  const a = NotesStore.addContact({
                    name: { given: 'Wilhelmina', family: 'Zonnebloem' },
                    phones: [{ type: 'mobile', value: '+31 6 98765432' }],
                    emails: [{ type: 'home', value: 'wilhelmina@zonnebloem.example' }],
                    addresses: [{ type: 'home', street: 'Geheimlaan 7', city: 'Zwolle' }],
                    labels: ['Familie'], favorite: true,
                  });
                  await NotesStore.pushDirty({ quiet: true });
                  return { uuid: a.uuid, dirty: NotesStore.state.dirty.size };
                }"""
            )
            assert made["dirty"] == 0, made

            # The server holds the row, but nothing readable.
            db_file = next((root / "data").rglob("*.db"))
            rows = list(
                sqlite3.connect(str(db_file)).execute(
                    "select ciphertext from items where item_uuid = ?", (made["uuid"],)
                )
            )
            assert len(rows) == 1, rows
            for needle in ("Wilhelmina", "Zonnebloem", "98765432", "Geheimlaan", "Zwolle", "contact"):
                assert needle not in rows[0][0], needle

            # The encrypted vault backup carries the contact too: its row decrypts to the contact,
            # and the file itself holds no readable name or number.
            with first.expect_download(timeout=60000) as download:
                first.evaluate("document.getElementById('btn-download-backup').click()")
            backup_text = Path(download.value.path()).read_text(encoding="utf-8")
            for needle in ("Wilhelmina", "Zonnebloem", "98765432", "Geheimlaan"):
                assert needle not in backup_text, needle
            exported = [r for r in json.loads(backup_text)["items"] if r["item_uuid"] == made["uuid"]]
            assert len(exported) == 1, made
            plain = first.evaluate(
                """(ciphertext) => NotesCrypto.decryptObject(NotesStore.state.cryptoKey, JSON.parse(ciphertext))""",
                exported[0]["ciphertext"],
            )
            assert plain["type"] == "contact" and plain["name"]["family"] == "Zonnebloem", plain

            # Second session of the same account.
            second = browser.new_context().new_page()
            login(second, base, email)
            second.wait_for_function(
                """async () => {
                  await NotesStore.sync({ quiet: true });
                  return NotesStore.listContacts().length === 1;
                }""",
                timeout=60000,
            )
            got = second.evaluate(
                """() => {
                  const c = NotesStore.listContacts()[0];
                  return { uuid: c.uuid, given: c.name.given, family: c.name.family, phone: c.phones[0].value,
                           street: c.addresses[0].street, labels: c.labels, favorite: c.favorite,
                           search: NotesStore.searchContacts('98765').length, notes: NotesStore.listNotes().length };
                }"""
            )
            assert got["uuid"] == made["uuid"], got
            assert (got["given"], got["family"]) == ("Wilhelmina", "Zonnebloem"), got
            assert got["phone"] == "+31 6 98765432" and got["street"] == "Geheimlaan 7", got
            assert got["labels"] == ["Familie"] and got["favorite"] is True and got["search"] == 1, got
            assert got["notes"] == 0, "a contact is not a note"

            # Edit on the second device, read on the first.
            second.evaluate(
                """async (id) => {
                  NotesStore.updateContact(id, { title: 'Directeur' });
                  await NotesStore.pushDirty({ quiet: true });
                }""",
                made["uuid"],
            )
            first.wait_for_function(
                """async () => {
                  await NotesStore.sync({ quiet: true });
                  return NotesStore.listContacts()[0].title === 'Directeur';
                }""",
                timeout=60000,
            )

            # Photo pipeline: a big JPEG and a transparent PNG become small opaque 192 px JPEGs.
            photo = first.evaluate(
                """async () => {
                  const draw = async (w, h, type, alpha) => {
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    const g = c.getContext('2d');
                    if (!alpha) { g.fillStyle = '#c33'; g.fillRect(0, 0, w, h); }
                    g.fillStyle = '#39c'; g.fillRect(w / 4, h / 4, w / 2, h / 2);
                    return new Promise((r) => c.toBlob(r, type, 0.95));
                  };
                  const big = await NotesContacts.encodePhoto(await draw(3000, 2000, 'image/jpeg', false));
                  const png = await NotesContacts.encodePhoto(await draw(400, 300, 'image/png', true));
                  const text = await NotesContacts.encodePhoto(new Blob(['not an image']));
                  const bytes = (p) => atob(p.photo.data).length;
                  const img = new Image();
                  img.src = 'data:image/jpeg;base64,' + png.photo.data;
                  await img.decode();
                  const c = document.createElement('canvas'); c.width = c.height = 192;
                  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
                  const corner = Array.from(g.getImageData(1, 1, 1, 1).data);
                  return { bigW: big.photo.w, bigBytes: bytes(big), exif: atob(big.photo.data).includes('Exif'),
                           pngBytes: bytes(png), corner, textError: text.error, mime: big.photo.mime };
                }"""
            )
            assert photo["bigW"] == 192 and 0 < photo["bigBytes"] <= 12288 and photo["mime"] == "image/jpeg", photo
            assert not photo["exif"] and 0 < photo["pngBytes"] <= 12288, photo
            assert min(photo["corner"][:3]) > 240 and photo["corner"][3] == 255, photo  # transparent -> white
            assert photo["textError"], photo

            # Lock removes the decrypted contacts from memory and from web storage.
            locked = first.evaluate(
                """() => {
                  NotesStore.lock();
                  const stores = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]);
                  return { count: NotesStore.listContacts().length, items: NotesStore.state.items.size,
                           leak: stores.includes('Zonnebloem') || stores.includes('98765432') };
                }"""
            )
            assert locked == {"count": 0, "items": 0, "leak": False}, locked
            browser.close()
        print("e2e_contacts_sync ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
