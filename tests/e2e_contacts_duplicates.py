"""E2E: find duplicates in the Contacts tab, merge or remove them, undo, and see the result in a second session.

Runs at 390 px and 1280 px. Checks that a merge keeps every distinct phone and email and deletes the other
contacts, that Remove keeps the chosen contact unchanged, that Not duplicates hides a group for the session,
that name-only groups are never part of Merge all exact matches (which asks first, with the count), that Undo
puts the previous contacts back, that "Merge with..." works on a single contact, that a merge made in one
session is seen in a second one, and how long Find duplicates takes with 2000 contacts.

    python tests/e2e_contacts_duplicates.py
"""
from __future__ import annotations

import tempfile
import time
from pathlib import Path

from e2e_contacts_sync import PASSWORD, UNLOCKED, contacts_action, free_port, login, register
from e2e_signup_autounlock import start_server

SEED = """() => {
  const add = (c) => NotesStore.addContact(c);
  add({ name: { given: 'Jan', family: 'Visser' }, org: { name: 'Acme' }, note: 'First note',
        phones: [{ type: 'mobile', value: '+31 6 12345678' }], emails: [{ type: 'home', value: 'Jan@Example.nl' }] });
  add({ name: { given: 'Johan', family: 'Visser' }, org: { name: 'Acme BV' }, title: 'CEO', note: 'Second note',
        phones: [{ type: 'home', value: '0031 6 1234 5678' }, { type: 'work', value: '020 1234567' }],
        emails: [{ value: 'jan@example.nl' }, { value: 'johan@other.nl' }] });
  add({ name: { given: 'Piet', family: 'Smit' }, emails: [{ value: 'piet@smit.nl' }] });
  add({ name: { given: 'Pieter', family: 'Smit' }, org: { name: 'Smit BV' }, emails: [{ value: 'PIET@smit.nl' }],
        phones: [{ value: '070 111 2222' }] });
  add({ name: { given: 'Zoë', family: 'Bakker' }, phones: [{ value: '0101234567' }] });
  add({ name: { given: 'zoe', family: 'bakker' }, phones: [{ value: '0207654321' }] });
  add({ name: { given: 'Karel' }, phones: [{ value: '0301111111' }] });
  add({ name: { given: 'Lotte' }, phones: [{ value: '0402222222' }] });
}"""

SNAPSHOT = """() => NotesStore.listContacts().map((c) => JSON.stringify({
  name: c.name, org: c.org, title: c.title, note: c.note, nickname: c.nickname, labels: c.labels, favorite: c.favorite,
  phones: c.phones.map((p) => [p.type, p.value]), emails: c.emails.map((p) => [p.type, p.value]),
  dates: c.dates.map((d) => [d.type, d.value]), uid: c.uid })).sort()"""


def given_names(page) -> list[str]:
    return page.evaluate("() => NotesStore.listContacts().map((c) => c.name.given).sort()")


def group_titles(page) -> list[str]:
    return page.eval_on_selector_all("#contacts-dup-list .contacts-dup-title", "els => els.map(e => e.textContent)")


def open_dialog(page) -> None:
    contacts_action(page, "#btn-contacts-duplicates")
    page.wait_for_selector("#contacts-dup-dialog:not([hidden])")


def close_dialog(page) -> None:
    page.click("#contacts-dup-close")
    page.wait_for_selector("#contacts-dup-dialog", state="hidden")


def no_overflow(page, where: str) -> None:
    over = page.evaluate(
        """() => { const d = document.getElementById('contacts-dup-dialog');
          const b = d.querySelector('.scan-dialog-body');
          return [document.documentElement.scrollWidth - window.innerWidth, b.scrollWidth - b.clientWidth,
                  d.getBoundingClientRect().right - window.innerWidth]; }"""
    )
    assert over[0] <= 0 and over[1] <= 0 and over[2] <= 0, f"{where}: overflow {over}"


def group_for(page, name: str):
    return page.locator("#contacts-dup-list .contacts-dup-group", has_text=name).first


def run_flow(page, width: int) -> None:
    where = f"{width}px"
    page.evaluate(SEED)
    page.click("#app-tab-contacts")
    page.wait_for_selector("#contacts-list .contacts-row-name")
    before = page.evaluate(SNAPSHOT)
    assert len(before) == 8, before

    # Find duplicates: two exact groups and one possible (name only).
    open_dialog(page)
    titles = group_titles(page)
    assert len(titles) == 3, titles
    kinds = page.eval_on_selector_all("#contacts-dup-list .contacts-dup-group", "els => els.map(e => e.classList.contains('possible'))")
    assert sorted(kinds) == [False, False, True], kinds
    possible = page.locator("#contacts-dup-list .contacts-dup-group.possible")
    assert "Possible duplicate" in possible.inner_text()
    assert page.evaluate("document.activeElement.classList.contains('contacts-dup-title')"), "focus moves into the first group"
    assert "(2 groups)" in page.inner_text("#contacts-dup-merge-all"), page.inner_text("#contacts-dup-merge-all")
    no_overflow(page, where)

    # Default keeper is the contact with the most filled fields.
    jan = group_for(page, "Visser")
    assert jan.locator("input[type=radio]:checked").get_attribute("aria-label") == "Keep Johan Visser"
    assert jan.locator(".contacts-dup-choice").count() >= 2, "differing name and organisation are offered"

    # Not duplicates hides the possible group, also after closing and reopening the screen.
    possible.get_by_role("button", name="Not duplicates").click()
    assert len(group_titles(page)) == 2
    close_dialog(page)
    open_dialog(page)
    assert len(group_titles(page)) == 2, "dismissed group stays hidden for the session"

    # Merge Jan Visser (by keyboard), keeping the kept contact's name and organisation.
    jan = group_for(page, "Visser")
    jan.locator(".contacts-dup-choice select").first.select_option(index=1)  # name: Jan instead of Johan
    merge = jan.get_by_role("button", name="Merge")
    merge.focus()
    page.keyboard.press("Enter")
    page.wait_for_function("() => NotesStore.listContacts().length === 7")
    merged = page.evaluate(
        """() => NotesStore.listContacts().filter((c) => c.name.family === 'Visser').map((c) => ({
          given: c.name.given, org: c.org.name, title: c.title, phones: c.phones.map((p) => p.value),
          emails: c.emails.map((p) => p.value), note: c.note }))"""
    )
    assert len(merged) == 1, merged
    m = merged[0]
    assert m["given"] == "Jan" and m["org"] == "Acme BV" and m["title"] == "CEO", m
    # The same number once, as the kept contact wrote it.
    assert sorted(m["phones"]) == ["0031 6 1234 5678", "020 1234567"], m
    assert sorted(v.lower() for v in m["emails"]) == ["jan@example.nl", "johan@other.nl"], m
    assert m["note"] == "Second note\n\nFirst note", m
    assert "Johan" not in given_names(page)
    assert "Merged 2 contacts into 1" in page.inner_text("#contacts-dup-status")
    assert page.is_visible("#contacts-dup-undo")
    no_overflow(page, where)

    # Undo after a merge restores exactly the previous contacts.
    page.click("#contacts-dup-undo")
    page.wait_for_function("() => NotesStore.listContacts().length === 8")
    assert page.evaluate(SNAPSHOT) == before, "undo of a merge restores the previous contacts"
    assert not page.is_visible("#contacts-dup-undo")

    # Remove duplicates keeps the chosen contact (not the default one) unchanged.
    smit = group_for(page, "Smit")
    smit.locator("input[type=radio][aria-label='Keep Piet Smit']").check()
    smit.get_by_role("button", name="Remove duplicates").click()
    page.wait_for_function("() => NotesStore.listContacts().length === 7")
    kept = [s for s in page.evaluate(SNAPSHOT) if "Smit" in s]
    assert len(kept) == 1 and [s for s in before if "Piet\"" in s and "Smit" in s] == kept, kept
    assert "Removed 1 duplicate" in page.inner_text("#contacts-dup-status")
    page.click("#contacts-dup-undo")
    page.wait_for_function("() => NotesStore.listContacts().length === 8")
    assert page.evaluate(SNAPSHOT) == before, "undo of a remove restores the previous contacts"

    # Merge all exact matches: asks first, states the count, leaves the name-only pair alone.
    page.click("#contacts-dup-merge-all")
    page.wait_for_selector("#confirm-dialog:not([hidden])")
    text = page.inner_text("#confirm-message")
    assert "4 contacts" in text and "2 groups" in text, text
    page.click("#confirm-cancel")
    page.wait_for_selector("#confirm-dialog", state="hidden")
    assert page.evaluate("NotesStore.listContacts().length") == 8, "cancel changes nothing"
    page.click("#contacts-dup-merge-all")
    page.wait_for_selector("#confirm-dialog:not([hidden])")
    page.click("#confirm-ok")
    page.wait_for_function("() => NotesStore.listContacts().length === 6")
    assert "Zoë" in given_names(page) and "zoe" in given_names(page), "the name-only pair is not merged"
    page.click("#contacts-dup-undo")
    page.wait_for_function("() => NotesStore.listContacts().length === 8")
    assert page.evaluate(SNAPSHOT) == before
    close_dialog(page)

    # Merge with... on a single contact's detail view.
    page.fill("#contacts-search", "Karel")
    page.click("#contacts-list .contacts-row-open")
    page.click(".contacts-merge-with")
    page.wait_for_selector("#contacts-dup-pick:not([hidden])")
    assert page.evaluate("document.activeElement.id") == "contacts-dup-search"
    page.fill("#contacts-dup-search", "Lott")
    page.click("#contacts-dup-pick-list button")
    group = page.locator("#contacts-dup-list .contacts-dup-group")
    group.wait_for()
    no_overflow(page, where)
    group.get_by_role("button", name="Merge").click()
    page.wait_for_function("() => NotesStore.listContacts().length === 7")
    left = page.evaluate("() => NotesStore.listContacts().filter((c) => ['Karel', 'Lotte'].includes(c.name.given)).map((c) => c.phones.map((p) => p.value))")
    assert len(left) == 1 and sorted(left[0]) == ["0301111111", "0402222222"], left
    close_dialog(page)
    assert not page.is_visible("#contacts-dup-undo"), "undo is gone after leaving the screen"
    page.fill("#contacts-search", "")

    # A merge that stays (no undo): the second session must see it.
    open_dialog(page)
    group_for(page, "Visser").get_by_role("button", name="Merge").click()
    page.wait_for_function("() => NotesStore.listContacts().length === 6")
    close_dialog(page)


def undo_failure(page) -> None:
    """A restore that is refused is counted in the status line, not replaced by the success message."""
    page.evaluate(
        """() => { for (let i = 0; i < 2; i += 1) NotesStore.addContact({ name: { given: 'Ruben', family: 'Undo' },
          emails: [{ value: 'ruben.undo@example.nl' }] }); }"""
    )
    before = page.evaluate("() => NotesStore.listContacts().length")
    open_dialog(page)
    group_for(page, "Undo").get_by_role("button", name="Remove duplicates").click()
    page.wait_for_function(f"() => NotesStore.listContacts().length === {before - 1}")
    page.evaluate(
        """() => { const add = NotesStore.addContact;
          NotesStore.addContact = (input) => { NotesStore.addContact = add; throw new Error('restore refused'); }; }"""
    )
    page.click("#contacts-dup-undo")
    status = page.inner_text("#contacts-dup-status")
    assert status == "Undone: 0 contacts restored, 1 contact could not be restored.", status
    assert page.evaluate("() => NotesStore.listContacts().length") == before - 1, "the refused contact is not back"
    close_dialog(page)


def check_second_session(browser, base: str, email: str) -> None:
    second = browser.new_context().new_page()
    login(second, base, email)
    second.wait_for_function(
        """async () => { await NotesStore.sync({ quiet: true }); return NotesStore.listContacts().length === 6; }""",
        timeout=60000,
    )
    names = second.evaluate("() => NotesStore.listContacts().map((c) => c.name.given + ' ' + c.name.family)")
    # Johan Visser had the most filled fields, so he is the one kept; Jan Visser and Lotte are gone.
    assert [n for n in names if n.endswith("Visser")] == ["Johan Visser"], names
    assert not any(n.startswith("Lotte") for n in names), names
    jan = second.evaluate("() => NotesStore.listContacts().find((c) => c.name.family === 'Visser').phones.map((p) => p.value).sort()")
    assert jan == ["0031 6 1234 5678", "020 1234567"], jan
    second.context.close()


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-contacts-dup-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for width, height in ((390, 844), (1280, 800)):
                context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 900)
                page = context.new_page()
                email = f"contacts-dup-{width}-{int(time.time())}@home.local"
                register(page, base, email)
                run_flow(page, width)
                if width == 1280:
                    page.evaluate("async () => { await NotesStore.pushDirty({ quiet: true }); }")
                    check_second_session(browser, base, email)
                    undo_failure(page)
                    timing(page)
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


def timing(page) -> None:
    """2000 contacts in the vault: Find duplicates (detection and first screen of groups) must not block the page."""
    page.evaluate(
        """() => { for (let i = 0; i < 2000; i += 1) {
          const base = i % 4 === 0 ? i - 1 : i;
          NotesStore.addContact({ name: { given: 'G' + (base % 700), family: 'F' + base },
            emails: [{ value: 'p' + base + '@example.com' }], phones: [{ value: '+31 6 ' + (10000000 + base) }] });
        } }"""
    )
    assert page.evaluate("NotesStore.listContacts().length") >= 2000
    ms = page.evaluate(
        """() => { const t = performance.now(); document.getElementById('btn-contacts-duplicates').click();
          return performance.now() - t; }"""
    )
    groups = page.eval_on_selector_all("#contacts-dup-list .contacts-dup-group", "els => els.length")
    print(f"find duplicates with {page.evaluate('NotesStore.listContacts().length')} contacts: {ms:.0f} ms, {groups} groups drawn")
    assert groups > 0 and ms < 1000, ms
    page.click("#contacts-dup-close")


if __name__ == "__main__":
    raise SystemExit(main())
