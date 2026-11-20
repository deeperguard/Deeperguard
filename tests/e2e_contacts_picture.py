"""E2E: a contact picture can be added (with a square crop), changed and removed.

Runs at 390 px and 1280 px. Checks the stored bytes (JPEG, size limit, no EXIF), that the original file never
appears in a request, the clear errors for bad files, mouse/touch/keyboard cropping, drag and drop, a second
session after sync and the vCard export.

    python tests/e2e_contacts_picture.py
"""
from __future__ import annotations

import base64
import struct
import tempfile
import time
from pathlib import Path

from e2e_contacts_sync import free_port, login, register
from e2e_signup_autounlock import start_server

SUBMIT = ".contacts-form button[type=submit]"
GPS_MARK = b"GPSLATITUDE52.3702N-GPSLONGITUDE4.8952E"
STORED = "NotesStore.listContacts().find((c) => c.name.given === 'Pia')"
MAKE_JPEG = """async () => {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 300;
  const g = c.getContext('2d');
  g.fillStyle = '#c33'; g.fillRect(0, 0, 200, 300);
  g.fillStyle = '#39c'; g.fillRect(200, 0, 200, 300);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}"""


def with_exif(jpeg: bytes) -> bytes:
    """Insert an APP1 EXIF segment holding a GPS marker right after the SOI marker."""
    body = b"Exif\x00\x00" + GPS_MARK
    return jpeg[:2] + b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body + jpeg[2:]


def stored(page) -> dict | None:
    return page.evaluate(f"() => {{ const c = {STORED}; return c ? {{ photo: c.photo }} : null; }}")


def photo_state(page, where: str, expect: bool) -> None:
    """The list row, the detail view and (when open) the edit form show a data: image or the initials."""
    for sel in (".contacts-row-open .contact-avatar", "#contacts-detail .contact-avatar"):
        if not page.query_selector(sel):
            continue
        has_img = page.query_selector(f"{sel} img") is not None
        assert has_img == expect, f"{where}: {sel} picture {has_img}, expected {expect}"
        if expect:
            src = page.get_attribute(f"{sel} img", "src")
            assert src.startswith("data:image/jpeg;base64,"), (where, src[:30])
            assert page.get_attribute(f"{sel} img", "alt") == "", where
        else:
            assert page.inner_text(sel).strip() == "P", (where, page.inner_text(sel))


def choose(page, name: str, mime: str, data: bytes) -> None:
    page.set_input_files(".contacts-photo input[type=file]", files=[{"name": name, "mimeType": mime, "buffer": data}])


def open_edit(page) -> None:
    page.click('[aria-label="Edit Pia Jansen"]')
    page.wait_for_selector("#contacts-f-given")


def run_flow(page, width: int, requests: list[bytes], jpeg: bytes) -> None:
    where = f"{width}px"
    phone = width < 900
    page.click("#app-tab-contacts")
    page.wait_for_selector("#contacts-pane:not([hidden])")
    page.click("#btn-contacts-add")
    page.wait_for_selector("#contacts-f-given")
    assert page.is_disabled(SUBMIT), "Save is disabled before any change"
    assert page.get_attribute(".contacts-photo input[type=file]", "accept") == "image/*"
    page.fill("#contacts-f-given", "Pia")
    page.fill("#contacts-f-family", "Jansen")
    assert not page.is_disabled(SUBMIT)

    # Choose: the crop step opens centred; one click on "Use picture" is enough.
    exif_jpeg = with_exif(jpeg)
    choose(page, "pia.jpg", "image/jpeg", exif_jpeg)
    page.wait_for_selector(".contacts-crop-frame")
    frame = page.locator(".contacts-crop-frame")
    assert page.is_disabled(SUBMIT), "Save waits for the crop step"
    assert frame.get_attribute("data-cx") == "0.500" and frame.get_attribute("data-cy") == "0.500", "default crop is centred"
    assert frame.get_attribute("data-zoom") == "1.00"
    page.wait_for_function("document.querySelector('.contacts-crop-frame img').naturalWidth === 400")
    box = frame.bounding_box()
    assert box["width"] >= 200 and abs(box["width"] - box["height"]) < 1.5, box
    for sel in (".contacts-crop-actions .btn", ".contacts-crop-zoomrow input"):
        for h in page.eval_on_selector_all(sel, "els => els.map(e => e.getBoundingClientRect().height)"):
            assert h >= 43.5, (where, sel, h)

    # Mouse drag moves the picture inside the frame (zoom in first so there is room to move).
    page.fill(".contacts-crop-zoomrow input", "2")
    page.dispatch_event(".contacts-crop-zoomrow input", "input")
    assert frame.get_attribute("data-zoom") == "2.00"
    cx0 = float(frame.get_attribute("data-cx"))
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] / 2 - 60, box["y"] + box["height"] / 2, steps=4)
    page.mouse.up()
    cx1 = float(frame.get_attribute("data-cx"))
    assert cx1 > cx0, ("mouse drag left shows more of the right", cx0, cx1)
    # Keyboard: arrows move, plus/minus zoom.
    frame.focus()
    page.keyboard.press("ArrowRight")
    assert float(frame.get_attribute("data-cx")) > cx1, "ArrowRight moves the crop right"
    page.keyboard.press("+")
    assert float(frame.get_attribute("data-zoom")) > 2.0
    page.keyboard.press("-")
    page.keyboard.press("-")
    assert float(frame.get_attribute("data-zoom")) < 2.0
    # Touch drag (CDP gives real touch pointer events).
    if phone:
        cdp = page.context.new_cdp_session(page)
        box = frame.bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        before = float(frame.get_attribute("data-cx"))
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        for dx in (-10, -20, -30, -40):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + dx, "y": y}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        assert float(frame.get_attribute("data-cx")) > before, "touch drag moves the picture"
    # Cancel the crop, choose again: the default is centred again and one click is enough.
    page.click("text=Cancel crop")
    page.wait_for_selector(".contacts-crop-frame", state="detached")
    choose(page, "pia.jpg", "image/jpeg", exif_jpeg)
    page.wait_for_selector(".contacts-crop-frame")
    assert frame.get_attribute("data-cx") == "0.500" and frame.get_attribute("data-zoom") == "1.00"
    page.click("text=Use picture")
    page.wait_for_selector(".contacts-crop-frame", state="detached")
    assert page.query_selector(".contacts-photo .contact-avatar img") is not None
    page.click(SUBMIT)
    page.wait_for_selector(".contacts-detail-name:has-text('Pia Jansen')")

    # Stored: a JPEG within the limit, no EXIF, no marker.
    photo = stored(page)["photo"]
    raw = base64.b64decode(photo["data"])
    assert photo["mime"] == "image/jpeg" and raw[:2] == b"\xff\xd8", photo["mime"]
    assert len(raw) <= 12288, len(raw)
    assert b"Exif" not in raw and GPS_MARK not in raw and b"GPS" not in raw, "EXIF must not survive"
    assert (photo["w"], photo["h"]) == (192, 192)
    # The centred square of a half red / half blue image: left red, right blue.
    px = page.evaluate(
        """async (data) => {
          const img = new Image(); img.src = 'data:image/jpeg;base64,' + data; await img.decode();
          const c = document.createElement('canvas'); c.width = c.height = 192;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          return [Array.from(g.getImageData(10, 96, 1, 1).data), Array.from(g.getImageData(180, 96, 1, 1).data)];
        }""",
        photo["data"],
    )
    assert px[0][0] > 150 and px[1][2] > 150, px

    # Shown in the detail view and the list row, then in the edit form.
    photo_state(page, f"{where} detail", True)
    photo_state(page, f"{where} row", True)
    open_edit(page)
    assert page.query_selector(".contacts-photo .contact-avatar img") is not None
    assert page.is_disabled(SUBMIT), "Save stays disabled until something changes"

    # Cancelling keeps the old picture and drops a chosen one.
    old = stored(page)["photo"]["data"]
    choose(page, "pia2.jpg", "image/jpeg", jpeg)
    page.wait_for_selector(".contacts-crop-frame")
    page.fill(".contacts-crop-zoomrow input", "2")
    page.dispatch_event(".contacts-crop-zoomrow input", "input")
    page.click("text=Use picture")
    page.wait_for_selector(".contacts-crop-frame", state="detached")
    assert not page.is_disabled(SUBMIT)
    page.click(".contacts-form-actions >> text=Cancel")
    page.get_by_role("button", name="Discard", exact=True).click()
    page.wait_for_selector(".contacts-detail-name:has-text('Pia Jansen')")
    assert stored(page)["photo"]["data"] == old, "cancel keeps the old picture"

    # Bad files: clear message, nothing changes.
    open_edit(page)
    bad = [
        ("broken.jpg", "image/jpeg", b"\xff\xd8\xff\xc0\x00\x11\x08\x00\x40\x00\x40\x03" + b"\x13\x37" * 300, "could not be read"),
        ("notes.txt", "text/plain", b"this is not a picture at all", "format not supported"),
        ("huge.jpg", "image/jpeg", jpeg[:100] + b"\x00" * (21 * 1024 * 1024), "too large"),
    ]
    for name, mime, data, msg in bad:
        choose(page, name, mime, data)
        page.wait_for_function(
            "(m) => { const e = document.getElementById('contacts-form-error'); return e && !e.hidden && e.textContent.includes(m); }", arg=msg
        )
        assert page.query_selector(".contacts-crop-frame") is None, name
        assert page.is_disabled(SUBMIT), f"{name}: nothing changed, Save stays disabled"
        assert stored(page)["photo"]["data"] == old, name
    page.click(".contacts-form-actions >> text=Cancel")
    page.wait_for_selector(".contacts-detail-name:has-text('Pia Jansen')")

    # Drag and drop of an image file on the picture area (desktop).
    if not phone:
        open_edit(page)
        page.evaluate(
            """async (b64) => {
              const bin = atob(b64); const u = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
              const dt = new DataTransfer();
              dt.items.add(new File([u], 'drop.jpg', { type: 'image/jpeg' }));
              document.querySelector('.contacts-photo').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
            }""",
            base64.b64encode(jpeg).decode(),
        )
        page.wait_for_selector(".contacts-crop-frame")
        page.click("text=Cancel crop")
        page.wait_for_selector(".contacts-crop-frame", state="detached")
        page.click(".contacts-form-actions >> text=Cancel")
        page.wait_for_selector(".contacts-detail-name:has-text('Pia Jansen')")

    # Remove: initials come back and the stored contact has no photo.
    open_edit(page)
    page.click("text=Remove picture")
    assert page.query_selector(".contacts-photo .contact-avatar img") is None
    assert page.inner_text(".contacts-photo .contact-avatar").strip() == "P"
    page.click(SUBMIT)
    page.wait_for_selector(".contacts-detail-name:has-text('Pia Jansen')")
    assert stored(page)["photo"] is None
    photo_state(page, f"{where} removed", False)

    # Nothing sent contains the original file or its EXIF.
    assert requests, "requests were recorded"
    for body in requests:
        assert GPS_MARK not in body and b"Exif" not in body and exif_jpeg[:600] not in body, "original image left the device"


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-contacts-picture-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            email = ""
            for width, height in ((390, 844), (1280, 800)):
                context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 900)
                page = context.new_page()
                requests: list[bytes] = []
                page.on("request", lambda r, sink=requests: sink.append(r.post_data_buffer or b""))
                email = f"contacts-picture-{width}-{int(time.time())}@home.local"
                register(page, base, email)
                jpeg = base64.b64decode(page.evaluate(MAKE_JPEG))
                run_flow(page, width, requests, jpeg)
                if width > 900:
                    # Second session: the picture arrives with the contact and goes into the vCard export.
                    open_edit(page)
                    choose(page, "pia.jpg", "image/jpeg", with_exif(jpeg))
                    page.wait_for_selector(".contacts-crop-frame")
                    page.click("text=Use picture")
                    page.wait_for_selector(".contacts-crop-frame", state="detached")
                    page.click(SUBMIT)
                    page.wait_for_selector(".contacts-detail-name:has-text('Pia Jansen')")
                    sent = page.evaluate("async () => { await NotesStore.pushDirty({ quiet: true }); return NotesStore.state.dirty.size; }")
                    assert sent == 0
                    mine = stored(page)["photo"]["data"]
                    second = browser.new_context().new_page()
                    login(second, base, email)
                    second.wait_for_function(
                        f"""async () => {{ await NotesStore.sync({{ quiet: true }});
                          const c = {STORED}; return !!(c && c.photo); }}""",
                        timeout=60000,
                    )
                    assert stored(second)["photo"]["data"] == mine, "same picture on the second session"
                    second.click("#app-tab-contacts")
                    second.wait_for_selector(".contacts-row-open .contact-avatar img")
                    vcard = second.evaluate(
                        "() => NotesContactsVcard.write(NotesStore.listContacts().filter((c) => c.name.given === 'Pia'))"
                    )
                    assert "PHOTO;ENCODING=b;TYPE=JPEG:" + mine in vcard.replace("\r\n ", ""), "vCard export carries the picture"
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
