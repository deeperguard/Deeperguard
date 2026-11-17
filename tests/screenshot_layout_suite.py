"""Screenshot suite for the app layout (docs/UI_POLISH.md section 7.10).

Starts a local server, signs up a throwaway account, creates synthetic data
(one plain note, one PDF note, a few agenda events, a few 2FA entries with
made-up secrets) and saves full-page PNGs of four screens at five widths:

    notes-plain-<width>.png, notes-pdf-<width>.png, agenda-<width>.png,
    2fa-<width>.png          (20 files)

    python tests/screenshot_layout_suite.py --out layout-screenshots

The default output folder is git-ignored. Nothing is committed.
"""
from __future__ import annotations

import argparse
import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_layout_actions import (  # noqa: E402
    DISMISS_JS, PDF_TITLE, PLAIN_TITLE, SEED_JS, make_pdf, open_note,
    phone_back_to_list, register, run_server, stop_server,
)

# (width, height): desktop sizes, tablet, phone.
SIZES = [(1280, 800), (1440, 900), (1920, 1080), (820, 1180), (390, 844)]
SCREENS = ["notes-plain", "notes-pdf", "agenda", "2fa"]
DEFAULT_OUT = "layout-screenshots"

AGENDA_JS = """() => {
  const S = NotesStore;
  const day = (offset, hour, minutes) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(hour, 0, 0, 0);
    return { start: d.toISOString(), end: new Date(d.getTime() + minutes * 60000).toISOString() };
  };
  const events = [
    ['Team sync (synthetic)', 0, 10, 60], ['Lunch (synthetic)', 0, 12, 60],
    ['Project review (synthetic)', 1, 14, 90], ['Dentist (synthetic)', 2, 9, 30],
    ['Planning (synthetic)', 3, 11, 60],
  ];
  events.forEach(([title, offset, hour, minutes]) =>
    S.upsertAgendaEvent(S.newUuid(), { title, all_day: false, ...day(offset, hour, minutes) }));
}"""

TOTP_ENTRIES = [
    ("Example Mail", "alice@example.test", "JBSWY3DPEHPK3PXP"),
    ("Example Cloud", "bob@example.test", "GEZDGNBVGY3TQOJQ"),
    ("Example Bank", "carol@example.test", "MFRGGZDFMZTWQ2LK"),
]


def add_totp(page) -> None:
    page.click("#app-tab-2fa", timeout=10000)
    page.wait_for_timeout(400)
    for issuer, account, secret in TOTP_ENTRIES:
        page.click("#btn-totp-add", timeout=10000)
        page.fill("#totp-add-issuer", issuer)
        page.fill("#totp-add-account", account)
        page.fill("#totp-add-secret", secret)
        page.click("#totp-add-save")
        page.wait_for_selector("text=" + issuer, timeout=10000)


def show(page, screen: str) -> None:
    # On tablet/phone an open note hides the list: go back before opening the
    # next. The back button is only shown on the Notes tab, so switch to it first.
    if screen.startswith("notes-"):
        page.click("#app-tab-notes", timeout=10000)
    phone_back_to_list(page)
    if screen == "notes-plain":
        open_note(page, PLAIN_TITLE)
    elif screen == "notes-pdf":
        open_note(page, PDF_TITLE)
        page.wait_for_timeout(1500)  # let the viewer render
    else:
        page.click("#app-tab-" + screen, timeout=10000)
        page.wait_for_timeout(800)


def main() -> int:
    from playwright.sync_api import sync_playwright

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", default=DEFAULT_OUT, help="output folder (default: " + DEFAULT_OUT + ")")
    out = Path(parser.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)

    proc, url = run_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
            register(page, url)
            page.evaluate(DISMISS_JS)
            page.evaluate(SEED_JS, base64.b64encode(make_pdf()).decode("ascii"))
            page.evaluate(AGENDA_JS)
            add_totp(page)
            for width, height in SIZES:
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(500)
                for screen in SCREENS:
                    show(page, screen)
                    page.mouse.move(width - 5, height - 5)
                    page.wait_for_timeout(300)
                    target = out / (screen + "-" + str(width) + ".png")
                    page.screenshot(path=str(target), full_page=True)
                    print("saved", target)
            browser.close()
    finally:
        stop_server(proc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
