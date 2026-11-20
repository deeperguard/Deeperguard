"""E2E: the Contacts tab sits between Agenda and 2FA and a contact can be added, edited, found and deleted.

Runs at 390 px and 1280 px. Also checks that HTML in a field is shown as text, that nothing
overflows horizontally, that touch targets are at least 44 px high and that the form opens by keyboard.

    python tests/e2e_contacts_tab.py
"""
from __future__ import annotations

import tempfile
import time
from pathlib import Path

from e2e_contacts_sync import free_port, register
from e2e_signup_autounlock import start_server

SUBMIT =".contacts-form button[type=submit]"
HOSTILE_ORG = '<img src=x onerror="window.__xss=1"> Corp'
HOSTILE_NOTE = "<script>window.__xss=2</script><b>bold</b>"


def no_hscroll(page, where: str) -> None:
    over = page.evaluate(
        "() => document.documentElement.scrollWidth - window.innerWidth"
    )
    assert over <= 0, f"{where}: horizontal overflow of {over}px"
    over = page.evaluate(
        """() => { const p = document.getElementById('contacts-pane');
          return p.scrollWidth - p.clientWidth; }"""
    )
    assert over <= 0, f"{where}: contacts pane overflows by {over}px"


def min_height(page, selector: str, where: str) -> None:
    heights = page.evaluate(
        """(sel) => [...document.querySelectorAll(sel)]
          .filter((e) => e.offsetParent !== null)
          .map((e) => e.getBoundingClientRect().height)""",
        selector,
    )
    assert heights, f"{where}: nothing matches {selector}"
    assert min(heights) >= 44, f"{where}: {selector} is only {min(heights)}px high"


def names_in_list(page) -> list[str]:
    return page.eval_on_selector_all(
        "#contacts-list .contacts-row-name", "els => els.map(e => e.textContent)"
    )


def run_flow(page, width: int) -> None:
    where = f"{width}px"
    phone = width < 900

    # Tab order and tab fit.
    tabs = page.eval_on_selector_all(".app-tab", "els => els.map(e => e.textContent.trim())")
    assert tabs == ["Notes", "Agenda", "Contacts", "2FA"], tabs
    fits = page.evaluate(
        """() => [...document.querySelectorAll('.app-tab')].every((t) => {
          const r = t.getBoundingClientRect();
          return r.left >= 0 && r.right <= window.innerWidth && t.scrollWidth <= t.clientWidth; })"""
    )
    assert fits, f"{where}: a tab is clipped"
    if phone:
        min_height(page, ".app-tab", where)

    page.click("#app-tab-contacts")
    page.wait_for_selector("#contacts-pane:not([hidden])")
    assert page.get_attribute("#app-tab-contacts", "aria-selected") == "true"
    assert page.evaluate("document.querySelectorAll('.app-tab[aria-selected=\"true\"]').length") == 1
    assert page.evaluate("!!document.getElementById(document.getElementById('app-tab-contacts').getAttribute('aria-controls'))")
    no_hscroll(page, where)

    # Empty state offers "Add contact".
    page.wait_for_selector("#contacts-empty-add:not([hidden])")

    # Open the form from the keyboard (+ button, Enter).
    page.focus("#btn-contacts-add")
    page.keyboard.press("Enter")
    page.wait_for_selector("#contacts-f-given")
    assert page.evaluate("document.activeElement.id") == "contacts-f-given"

    # Tab walks the fields in reading order; Shift+Tab walks back.
    order = []
    for _ in range(4):
        page.keyboard.press("Tab")
        order.append(page.evaluate("document.activeElement.id"))
    assert order == ["contacts-f-family", "contacts-f-nick", "contacts-f-org", "contacts-f-title"], order
    page.keyboard.press("Shift+Tab")
    assert page.evaluate("document.activeElement.id") == "contacts-f-org"

    # Save waits for a change; a form holding only a blank is refused with an alert.
    assert page.is_disabled(SUBMIT)
    page.fill("#contacts-f-given", " ")
    page.click(SUBMIT)
    assert "Enter a name" in page.inner_text("#contacts-form-error")
    assert page.get_attribute("#contacts-f-given", "aria-invalid") == "true"

    page.fill("#contacts-f-given", "Wilhelmina")
    page.fill("#contacts-f-family", "Zonnebloem")
    page.fill("#contacts-f-org", HOSTILE_ORG)
    page.fill("#contacts-f-note", HOSTILE_NOTE)
    page.click("text=Add phone")
    page.fill('[aria-label="Phone 1"]', "+31 6 98765432 ext. 12")
    page.click("text=Add phone")
    page.fill('[aria-label="Phone 2"]', "020 555 0101")
    page.select_option('[aria-label="Phone 2 type"]', "work")
    page.click("text=Add email")
    page.fill('[aria-label="Email 1"]', "wilhelmina@zonnebloem.example")
    page.click("text=Add email")
    page.fill('[aria-label="Email 2"]', "w.zonnebloem@werk.example")
    if phone:
        no_hscroll(page, f"{where} form")
        min_height(page, ".contacts-form input:not([type=checkbox]):not([type=file]), .contacts-form select, .contacts-form .btn", f"{where} form")
    page.click(SUBMIT)
    page.wait_for_selector(".contacts-detail-name:has-text('Wilhelmina Zonnebloem')")

    # Detail: links, plain text for hostile fields.
    hrefs = page.eval_on_selector_all(
        "#contacts-detail a[href]", "els => els.map(e => e.getAttribute('href'))"
    )
    assert "tel:+31698765432" in hrefs, hrefs  # "ext. 12" is not dialled
    assert "tel:0205550101" in hrefs, hrefs
    assert "mailto:wilhelmina@zonnebloem.example" in hrefs, hrefs
    detail = page.inner_text("#contacts-detail")
    assert HOSTILE_ORG in detail and HOSTILE_NOTE in detail, detail
    assert page.evaluate("window.__xss") is None
    assert page.query_selector("#contacts-detail img[src='x']") is None
    assert page.query_selector("#contacts-detail script") is None
    assert page.query_selector("#contacts-detail b") is None
    assert page.get_attribute('[aria-label="Copy phone 1 of Wilhelmina Zonnebloem"]', "type") == "button"
    no_hscroll(page, f"{where} detail")

    # Edit: rename, drop the second email, add a website.
    page.click('[aria-label="Edit Wilhelmina Zonnebloem"]')
    page.wait_for_selector("#contacts-f-given")
    page.fill("#contacts-f-given", "Willemijn")
    page.click('[aria-label="Remove email 2"]')
    page.click("text=Add website")
    page.fill('[aria-label="Website 1"]', "https://zonnebloem.example")
    page.click(SUBMIT)
    page.wait_for_selector(".contacts-detail-name:has-text('Willemijn Zonnebloem')")
    assert page.query_selector("a[href='mailto:w.zonnebloem@werk.example']") is None
    assert page.query_selector("a[href^='https://zonnebloem.example']") is not None

    # A second contact so that search has something to exclude.
    if phone:
        page.click('[aria-label="Back to contacts"]')
    page.click("#btn-contacts-add")
    page.fill("#contacts-f-given", "Anna")
    page.fill("#contacts-f-family", "Jansen")
    page.click("text=Add phone")
    page.fill('[aria-label="Phone 1"]', "06 1111 2222")
    page.click(SUBMIT)
    page.wait_for_selector(".contacts-detail-name:has-text('Anna Jansen')")
    if phone:
        page.click('[aria-label="Back to contacts"]')
    assert names_in_list(page) == ["Anna Jansen", "Willemijn Zonnebloem"], names_in_list(page)
    assert page.inner_text("#contacts-count") == "2 contacts"
    if phone:
        min_height(page, ".contacts-row-open, .contacts-star", f"{where} list")
        no_hscroll(page, f"{where} list")

    # Search by name, by phone number (formatting ignored) and by email.
    for query, expected in (
        ("willem", ["Willemijn Zonnebloem"]),
        ("6987654", ["Willemijn Zonnebloem"]),
        ("0205550101", ["Willemijn Zonnebloem"]),
        ("zonnebloem.example", ["Willemijn Zonnebloem"]),
        ("anna", ["Anna Jansen"]),
        ("nobody-here", []),
    ):
        page.fill("#contacts-search", query)
        assert names_in_list(page) == expected, (query, names_in_list(page))
    assert "No contacts match" in page.inner_text("#contacts-empty-text")
    page.fill("#contacts-search", "")

    # Favourite star.
    page.click('[aria-label="Favourite: Anna Jansen"]')
    assert page.get_attribute('[aria-label="Favourite: Anna Jansen"]', "aria-pressed") == "true"
    assert page.inner_text("#contacts-list .contacts-section >> nth=0") == "Favourites"

    # A failing save shows an error toast and leaves the star as it was.
    page.evaluate(
        """() => { window.__realUpdate = NotesStore.updateContact;
          NotesStore.updateContact = () => { throw new Error('Test write failed'); }; }"""
    )
    page.click('[aria-label="Favourite: Anna Jansen"]')
    page.wait_for_function("() => document.getElementById('toast')?.textContent === 'Test write failed'")
    assert "error" in page.get_attribute("#toast", "class")
    assert page.get_attribute('[aria-label="Favourite: Anna Jansen"]', "aria-pressed") == "true"
    page.evaluate("() => { NotesStore.updateContact = window.__realUpdate; }")
    page.click('[aria-label="Favourite: Anna Jansen"]')
    assert page.get_attribute('[aria-label="Favourite: Anna Jansen"]', "aria-pressed") == "false"

    # Delete with confirmation, cancel first.
    page.click("#contacts-list [data-contact-id] >> text=Willemijn Zonnebloem")
    page.click('[aria-label="Delete contact Willemijn Zonnebloem"]')
    page.wait_for_selector("#confirm-dialog:not([hidden])")
    page.click("#confirm-cancel")
    assert "Willemijn Zonnebloem" in page.inner_text("#contacts-detail")
    page.click('[aria-label="Delete contact Willemijn Zonnebloem"]')
    page.wait_for_selector("#confirm-dialog:not([hidden])")
    page.click("#confirm-ok")
    page.wait_for_function("() => document.getElementById('contacts-detail').hidden")
    assert names_in_list(page) == ["Anna Jansen"], names_in_list(page)
    assert page.evaluate("NotesStore.listContacts().length") == 1

    # "/" from a list row moves focus to the search field without typing a slash into it.
    page.focus("#contacts-list .contacts-row-open")
    page.keyboard.press("/")
    assert page.evaluate("document.activeElement.id") == "contacts-search"
    assert page.input_value("#contacts-search") == ""

    # Escape in a changed form asks first: Cancel keeps the draft, Discard drops it unsaved.
    page.click("#btn-contacts-add")
    page.fill("#contacts-f-given", "Draft")
    page.press("#contacts-f-given", "Escape")
    page.wait_for_selector("#confirm-dialog:not([hidden])")
    page.click("#confirm-cancel")
    page.wait_for_selector("#confirm-dialog", state="hidden")
    assert page.input_value("#contacts-f-given") == "Draft"
    page.press("#contacts-f-given", "Escape")
    page.wait_for_selector("#confirm-dialog:not([hidden])")
    page.click("#confirm-ok")
    page.wait_for_selector("#contacts-f-given", state="detached")
    assert names_in_list(page) == ["Anna Jansen"], names_in_list(page)
    assert page.evaluate("NotesStore.listContacts().length") == 1

    # Lock clears contacts from the page.
    page.click("#btn-contacts-lock")
    page.wait_for_function("() => !NotesStore.isUnlocked()")
    assert names_in_list(page) == []
    assert "Anna" not in page.evaluate("document.getElementById('contacts-pane').textContent")


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-contacts-tab-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for width, height in ((390, 844), (1280, 800)):
                context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 900)
                page = context.new_page()
                register(page, base, f"contacts-tab-{width}-{int(time.time())}@home.local")
                run_flow(page, width)
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
