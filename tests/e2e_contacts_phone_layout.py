"""E2E: the Contacts tab gives the list room on phones (compact header, sticky search, "more" menu).

With 36 contacts of which 8 are favourites it measures the first contact row and the rows that are fully
visible at 390x844 and 360x740, scrolls the list, and drives the "more" menu with the keyboard.
Measured on this layout and on the commit before it (4abd9bb):

    viewport   first row top (before -> after)   fully visible rows (before -> after)
    390x844    405 -> 220                        7 -> 10
    360x740    405 -> 220                        5 -> 9

    python tests/e2e_contacts_phone_layout.py
"""
from __future__ import annotations

import tempfile
import time
from pathlib import Path

from e2e_contacts_sync import free_port, register
from e2e_signup_autounlock import start_server

# (first row top, fully visible rows) measured before the compact header, per viewport
BEFORE = {390: (405, 7), 360: (405, 5)}

SEED = """() => {
  const names = ['Anna','Bram','Chris','Daan','Eva','Fleur','Guus','Hanna','Ivo','Jelle','Karin','Lars','Mila','Noor',
    'Otto','Pim','Quinn','Roos','Sem','Tess','Uma','Vera','Wim','Xavi','Yara','Zoe','Aron','Bo','Cas','Dirk','Elif',
    'Finn','Gijs','Hugo','Iris','Joep'];
  names.forEach((n, i) => NotesStore.addContact({ name: { given: n, family: 'Test' + i }, favorite: i % 5 === 0,
    phones: [{ type: 'mobile', value: '06 1234 56' + String(10 + i) }] }));
}"""

LIST_METRICS = """() => {
  const rows = [...document.querySelectorAll('#contacts-list .contacts-row')];
  const first = rows[0].getBoundingClientRect();
  const full = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight; });
  return { firstTop: first.top, fullRows: full.length, total: rows.length };
}"""

SCROLL_METRICS = """() => {
  const pane = document.getElementById('contacts-pane');
  const paneTop = pane.getBoundingClientRect().top;
  const head = document.querySelector('#contacts-pane .contacts-head').getBoundingClientRect();
  const bar = document.querySelector('#contacts-pane .search-wrap').getBoundingClientRect();
  const chips = document.getElementById('contacts-chips').getBoundingClientRect();
  const rows = [...document.querySelectorAll('#contacts-list .contacts-row')].map((r) => r.getBoundingClientRect());
  const firstShown = rows.find((r) => r.bottom > bar.bottom);
  return { scrollTop: pane.scrollTop, paneTop, headBottom: head.bottom, barTop: bar.top, barBottom: bar.bottom,
           chipsBottom: chips.bottom, firstShownTop: firstShown ? firstShown.top : null,
           lastBottom: rows[rows.length - 1].bottom, innerHeight: window.innerHeight };
}"""


def no_hscroll(page, where: str) -> None:
    over = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    assert over <= 0, f"{where}: horizontal overflow of {over}px"
    over = page.evaluate("() => { const p = document.getElementById('contacts-pane'); return p.scrollWidth - p.clientWidth; }")
    assert over <= 0, f"{where}: contacts pane overflows by {over}px"


def heights(page, selector: str) -> list[float]:
    return page.evaluate(
        """(sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null)
          .map((e) => e.getBoundingClientRect().height)""",
        selector,
    )


def open_contacts(page) -> None:
    page.evaluate(SEED)
    page.click("#app-tab-contacts")
    page.wait_for_selector("#contacts-list .contacts-row")
    page.wait_for_function("() => document.getElementById('contacts-count').textContent === '36 contacts'")


def check_phone(page, width: int, height: int, min_rows: int) -> None:
    where = f"{width}x{height}"
    before_top, before_rows = BEFORE[width]
    open_contacts(page)
    m = page.evaluate(LIST_METRICS)
    print(f"{where}: first row at y={m['firstTop']:.0f}, {m['fullRows']} rows fully visible "
          f"(before: y={before_top}, {before_rows} rows)")
    assert m["firstTop"] <= before_top - 180, f"{where}: first row at {m['firstTop']}"
    assert m["fullRows"] > before_rows and m["fullRows"] >= min_rows, f"{where}: only {m['fullRows']} rows fully visible"
    assert page.inner_text("#contacts-list .contacts-section >> nth=0") == "Favourites"
    no_hscroll(page, where)

    # Touch targets: rows, stars, header buttons, label chips.
    for sel in ("#contacts-list .contacts-row-open, #contacts-list .contacts-star",
                "#btn-contacts-add, #btn-contacts-more, #btn-contacts-lock, #btn-contacts-settings",
                "#contacts-chips .tag-chip"):
        low = min(heights(page, sel))
        assert low >= 44, f"{where}: {sel} is only {low}px high"
    # Row content is kept: initials, name, phone, star.
    row = page.inner_text("#contacts-list .contacts-row >> nth=0")
    assert "Anna Test0" in row and "06 1234 5610" in row and page.query_selector("#contacts-list .contacts-row .contact-avatar")

    # Scroll down: header and chips leave, only the search bar stays, no row sits under it.
    top = page.evaluate(SCROLL_METRICS)
    assert top["firstShownTop"] >= top["barBottom"], f"{where}: first row starts under the search bar ({top})"
    page.evaluate("() => { document.getElementById('contacts-pane').scrollTop = 700; }")
    page.wait_for_function("() => document.getElementById('contacts-pane').scrollTop > 600")
    s = page.evaluate(SCROLL_METRICS)
    assert s["headBottom"] <= s["paneTop"], f"{where}: header still visible after scrolling ({s})"
    assert s["chipsBottom"] <= s["paneTop"] + 1, f"{where}: chips still visible after scrolling ({s})"
    assert abs(s["barTop"] - s["paneTop"]) <= 1, f"{where}: search bar is not pinned ({s})"
    assert s["barBottom"] - s["barTop"] <= 56, f"{where}: sticky bar is not slim ({s})"
    covered = page.evaluate(
        """() => { const b = document.querySelector('#contacts-pane .search-wrap').getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + 4, b.top + b.height / 2);
          return !!hit.closest('.search-wrap'); }"""
    )
    assert covered, f"{where}: the search bar is not on top"
    # Scroll to the end: the last contact is fully reachable above the bottom inset.
    page.evaluate("() => { const p = document.getElementById('contacts-pane'); p.scrollTop = p.scrollHeight; }")
    end = page.evaluate(SCROLL_METRICS)
    assert end["lastBottom"] <= end["innerHeight"], f"{where}: last row is cut off ({end})"
    # Back to the top: everything is back, in the same place.
    page.evaluate("() => { document.getElementById('contacts-pane').scrollTop = 0; }")
    back = page.evaluate(SCROLL_METRICS)
    assert back == top, f"{where}: layout moved after scrolling back ({back} vs {top})"
    again = page.evaluate(LIST_METRICS)
    assert again["firstTop"] == m["firstTop"], f"{where}: first row jumped from {m['firstTop']} to {again['firstTop']}"


def check_menu(page, width: int) -> None:
    where = f"{width}px menu"
    more = "#btn-contacts-more"
    assert page.get_attribute(more, "aria-haspopup") == "menu" and page.get_attribute(more, "aria-controls") == "contacts-more-menu"
    assert page.get_attribute(more, "aria-expanded") == "false"
    assert not page.is_visible("#btn-contacts-import"), "menu items are hidden until the menu is open"

    # Keyboard: Enter opens and focuses the first item, arrows move, Escape closes and returns to the button.
    page.focus(more)
    page.keyboard.press("Enter")
    page.wait_for_selector("#contacts-more-menu.is-open")
    assert page.get_attribute(more, "aria-expanded") == "true"
    assert page.get_attribute("#contacts-more-menu", "role") == "menu"
    assert page.get_attribute("#contacts-more-menu", "aria-label") == "More contact actions"
    items = page.eval_on_selector_all(
        "#contacts-more-menu [role=menuitem], #contacts-more-menu [role=menuitemcheckbox]",
        "els => els.map(e => [e.getAttribute('role'), e.textContent.trim()])",
    )
    assert items == [["menuitem", "Find duplicates"], ["menuitem", "Import"], ["menuitemcheckbox", "Select"],
                     ["menuitem", "Export"], ["menuitem", "Expand sidebar"]], items
    assert page.evaluate("document.activeElement.id") == "btn-contacts-duplicates"
    page.keyboard.press("ArrowDown")
    assert page.evaluate("document.activeElement.id") == "btn-contacts-import"
    page.keyboard.press("End")
    assert page.evaluate("document.activeElement.textContent.trim()") == "Expand sidebar"
    page.keyboard.press("ArrowDown")
    assert page.evaluate("document.activeElement.id") == "btn-contacts-duplicates"
    page.keyboard.press("Escape")
    page.wait_for_selector("#contacts-more-menu:not(.is-open)", state="attached")
    assert page.evaluate("document.activeElement.id") == "btn-contacts-more"
    assert page.get_attribute(more, "aria-expanded") == "false"

    # Tab from an open menu closes it and moves focus to the next control in the header (the + button),
    # then Tab goes on to the more button. The menu items are not left behind as the focus.
    page.focus(more)
    page.keyboard.press("Enter")
    page.wait_for_selector("#contacts-more-menu.is-open")
    page.keyboard.press("Tab")
    page.wait_for_selector("#contacts-more-menu:not(.is-open)", state="attached")
    assert page.evaluate("document.activeElement.id") == "btn-contacts-add", page.evaluate("document.activeElement.outerHTML")
    assert page.get_attribute(more, "aria-expanded") == "false"
    page.keyboard.press("Tab")
    assert page.evaluate("document.activeElement.id") == "btn-contacts-more"

    # Import opens its dialog; closing it returns focus to a visible button (the menu button).
    page.click(more)
    page.click("#btn-contacts-import")
    page.wait_for_selector("#contacts-import-dialog:not([hidden])")
    assert not page.evaluate("document.getElementById('contacts-more-menu').classList.contains('is-open')")
    page.click("#contacts-import-close")
    page.wait_for_selector("#contacts-import-dialog", state="hidden")
    assert page.evaluate("document.activeElement.id") == "btn-contacts-more"

    # Export asks for the password before anything is written.
    page.click(more)
    page.click("#btn-contacts-export")
    page.wait_for_selector("#confirm-password-wrap:not([hidden])")
    assert "36 contacts will be exported" in page.inner_text("#confirm-dialog")
    page.click("#confirm-cancel")

    # Select switches to tick mode and back; the menu item reports its state.
    page.click(more)
    page.click("#btn-contacts-select")
    assert page.get_attribute("#btn-contacts-select", "aria-checked") == "true"
    assert page.locator("[data-contact-tick]").count() == 36
    page.click(more)
    page.click("#btn-contacts-select")
    assert page.get_attribute("#btn-contacts-select", "aria-checked") == "false"
    assert page.locator("[data-contact-tick]").count() == 0

    # Outside click closes the menu; the sidebar toggle in the menu still works.
    page.click(more)
    page.click(".contacts-title")
    assert not page.evaluate("document.getElementById('contacts-more-menu').classList.contains('is-open')")
    pinned = page.evaluate("document.body.classList.contains('nav-pinned')")
    page.click(more)
    page.click(".contacts-menu-nav-toggle")
    assert page.evaluate("document.body.classList.contains('nav-pinned')") != pinned
    page.click(more)
    page.click(".contacts-menu-nav-toggle")
    assert page.evaluate("document.body.classList.contains('nav-pinned')") == pinned
    no_hscroll(page, where)

    # Settings and Add stay in the header; Lock clears the list.
    page.click("#btn-contacts-add")
    page.wait_for_selector("#contacts-f-given")
    page.click(".contacts-form-actions >> text=Cancel")
    page.wait_for_selector("#contacts-f-given", state="detached")
    page.click("#btn-contacts-lock")
    page.wait_for_function("() => !NotesStore.isUnlocked()")


def check_desktop(page) -> None:
    open_contacts(page)
    for sel in ("#btn-contacts-duplicates", "#btn-contacts-import", "#btn-contacts-select", "#btn-contacts-export",
                "#btn-contacts-add", "#btn-contacts-lock", "#btn-contacts-settings", "#btn-contacts-nav-toggle"):
        assert page.is_visible(sel), f"desktop: {sel} is not visible"
    assert not page.is_visible("#btn-contacts-more")
    assert not page.is_visible(".contacts-menu-nav-toggle")
    assert page.get_attribute("#contacts-more-menu", "role") is None
    assert page.get_attribute("#btn-contacts-select", "aria-pressed") == "false"
    assert page.get_attribute("#btn-contacts-import", "role") is None
    no_hscroll(page, "desktop")
    page.click("#btn-contacts-import")
    page.wait_for_selector("#contacts-import-dialog:not([hidden])")
    page.click("#contacts-import-close")
    assert page.evaluate("document.activeElement.id") == "btn-contacts-import"


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-contacts-phone-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for width, height, rows in ((390, 844, 9), (360, 740, 8), (1280, 800, 0)):
                context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 900)
                page = context.new_page()
                register(page, base, f"contacts-phone-{width}-{int(time.time())}@home.local")
                if width < 900:
                    check_phone(page, width, height, rows)
                    if width == 390:
                        check_menu(page, width)
                else:
                    check_desktop(page)
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
