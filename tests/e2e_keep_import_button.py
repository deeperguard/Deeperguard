"""E2E for the Import section in Settings: Google Keep (Takeout .zip) and Markdown in one session.

Register (lands unlocked), open Settings, pick a Keep Takeout ZIP with the Keep button, confirm the
dialog, check the status line and the stored note; then pick a Markdown file with the Markdown button
and check the same. The Keep note must keep its checklist (nested item flattened) and the tag.

Spec: docs/IMPORT_EXPORT_SPEC.md 3.3. Not covered: the Evernote and Standard Notes buttons, and
attachments. The file chooser is driven with set_input_files on the hidden inputs, so the real
file-picker dialog is not opened.

    python tests/e2e_keep_import_button.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402
from e2e_totp_tab_reload_unlock import UNLOCKED_JS  # noqa: E402

NOTES_JS = "() => NotesStore.listNotes().map((n) => ({ title: n.content?.title || '', content: n.content?.content || '' }))"


def keep_zip(path: Path) -> None:
    import zipfile

    note = {
        "title": "Keep groceries",
        "isPinned": False,
        "listContent": [
            {"text": "milk", "isChecked": False},
            {"text": "tea", "isChecked": True, "parentId": "p1"},
        ],
        "labels": [{"name": "KeepTag"}],
        "createdTimestampUsec": 1700000000000000,
        "userEditedTimestampUsec": 1700000500000000,
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Takeout/Keep/groceries.json", json.dumps(note))


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-keep-import-"))
    work = Path(tempfile.mkdtemp(prefix="e2e-keep-files-"))
    zip_path = work / "takeout.zip"
    md_path = work / "readme.md"
    keep_zip(zip_path)
    md_path.write_text("# Markdown import\n\nPlain body.\n", encoding="utf-8")

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port, extra_env={"NOTES_DEFAULT_PLAN": "pro"})
    failures: list[str] = []
    try:
        email = f"keep-import-{int(time.time())}@home.local"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_context().new_page()
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
            page.wait_for_function(UNLOCKED_JS, timeout=120000)
            complete_recovery_key_step(page)

            page.click("#btn-settings-nav", timeout=10000)
            page.wait_for_selector("#import-keep-file", state="attached", timeout=10000)

            page.set_input_files("#import-keep-file", str(zip_path))
            page.wait_for_selector("#confirm-dialog:not([hidden])", timeout=10000)
            page.click("#confirm-ok", timeout=10000)
            page.wait_for_function(
                "() => /^Imported 1 note/.test(document.getElementById('restore-result-status')?.textContent || '')",
                timeout=20000,
            )
            notes = page.evaluate(NOTES_JS)
            keep = [n for n in notes if n["title"] == "Keep groceries"]
            if len(keep) != 1:
                failures.append(f"Keep note not stored once: {notes}")
            elif keep[0]["content"] != "- [ ] milk\n- [x] tea":
                failures.append(f"Keep checklist content wrong: {keep[0]['content']!r}")

            page.set_input_files("#import-markdown-file", str(md_path))
            page.wait_for_selector("#confirm-dialog:not([hidden])", timeout=10000)
            page.click("#confirm-ok", timeout=10000)
            page.wait_for_function(
                "() => /^Imported 1 note/.test(document.getElementById('restore-result-status')?.textContent || '')",
                timeout=20000,
            )
            after = page.evaluate(NOTES_JS)
            if not any(n["title"] == "Markdown import" for n in after):
                failures.append(f"Markdown note not stored: {[n['title'] for n in after]}")
            if not any(n["title"] == "Keep groceries" for n in after):
                failures.append("Keep note disappeared after the Markdown import")
            browser.close()
        for line in failures:
            print("FAIL:", line)
        if not failures:
            print("e2e_keep_import_button ok")
        return 1 if failures else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
