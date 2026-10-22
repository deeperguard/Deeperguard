"""E2E: View server copy for note, tag, folder, totp, attachment.

    python tests/e2e_server_copy.py
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
PASSWORD = "e2e-server-copy-12chars"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(root: Path, port: int):
    env = dict(os.environ)
    env.update(
        NOTES_ROOT=str(root),
        NOTES_DATA=str(root / "data"),
        NOTES_KEYS=str(root / "keys"),
        NOTES_ALLOWED_CIDRS="127.0.0.1/32",
        NOTES_SKIP_LOGIN="0",
        NOTES_ALLOW_REGISTER="1",
        NOTES_DISABLE_CIDR_GATE="1",
        NOTES_STRICT_ZK="1",
        NOTES_SECURE_COOKIES="0",
        FLASK_APP="app",
        PYTHONPATH=str(APP_DIR),
    )
    env.pop("NOTES_TURNSTILE_SECRET_KEY", None)
    env.pop("NOTES_TURNSTILE_SITE_KEY", None)
    (root / "keys").mkdir(parents=True, exist_ok=True)
    (root / "keys" / "flask-secret").write_text("e2e-server-copy", encoding="utf-8")
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


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-server-copy-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        email = f"server-copy-{int(time.time())}@home.local"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(f"{base}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', email)
            page.fill('input[name="password"]', PASSWORD)
            page.fill('input[name="password2"]', PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click('#register-form button[type="submit"]')
            page.wait_for_function(
                """() => location.pathname === '/app'
                  && !!(window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked())
                  && !!(NotesStore.isKeyVerified && NotesStore.isKeyVerified())""",
                timeout=120000,
            )

            page.wait_for_timeout(500)
            ids = page.evaluate(
                """async () => {
                  // Empty-vault prove can settle a tick after isUnlocked().
                  if (!NotesStore.isKeyVerified()) {
                    if (typeof NotesStore.markKeyVerified === 'function') NotesStore.markKeyVerified();
                  }
                  if (!NotesStore.isKeyVerified()) {
                    throw new Error('vault key not verified after sign-up');
                  }
                  const noteId = NotesStore.newUuid();
                  NotesStore.upsert(noteId, {
                    ...NotesStore.defaultNote(),
                    title: 'Server copy note',
                    content: 'Secret body for ZK check',
                  });
                  const tagId = NotesStore.newUuid();
                  NotesStore.upsert(tagId, NotesStore.defaultTag('zk-tag'));
                  const folderId = NotesStore.createFolder('zk-folder');
                  const totp = NotesStore.addTotpAccount({
                    account: 'ZK TOTP',
                    secret: 'JBSWY3DPEHPK3PXP',
                    issuer: 'Deeperguard',
                  });
                  const file = new File([new TextEncoder().encode('tiny-file')], 'zk.txt', {
                    type: 'text/plain',
                  });
                  const att = await NotesStore.addAttachment(noteId, file);
                  const attId = att.uuid || att;
                  const note = NotesStore.get(noteId);
                  NotesStore.upsert(noteId, {
                    ...note.content,
                    folder_id: folderId,
                    tags: [tagId],
                  });
                  await NotesStore.flush();
                  await NotesStore.pushDirty({ quiet: true });
                  return {
                    noteId,
                    tagId,
                    folderId,
                    totpId: totp.uuid || '',
                    attId,
                  };
                }"""
            )

            for kind, uuid in (
                ("note", ids["noteId"]),
                ("tag", ids["tagId"]),
                ("folder", ids["folderId"]),
                ("totp", ids["totpId"]),
                ("attachment", ids["attId"]),
            ):
                assert uuid, f"missing {kind} id"
                page.evaluate(
                    """async (uuid) => {
                      await window.__notesOpenServerCopy(uuid);
                    }""",
                    uuid,
                )
                page.wait_for_selector("#server-copy-dialog:not([hidden])")
                raw = page.inner_text("#server-copy-raw")
                plain = page.inner_text("#server-copy-plain")
                assert "item_uuid" in raw or "ciphertext" in raw, f"{kind}: missing server fields"
                assert '"v"' in raw or '"iv"' in raw or "iv" in raw, f"{kind}: ciphertext envelope missing"
                assert "Secret body" not in raw and "JBSWY3DPEHPK3PXP" not in raw, (
                    f"{kind}: plaintext leaked into server JSON panel"
                )
                assert plain.strip(), f"{kind}: empty plaintext panel"
                # Close for next item.
                page.click("#server-copy-close")
                page.wait_for_selector("#server-copy-dialog[hidden]", state="attached")

            # /verify is public and linked.
            v = page.goto(f"{base}/verify", wait_until="domcontentloaded")
            assert v and v.status == 200
            assert "Verify zero-knowledge" in page.content()
            browser.close()
        print("e2e_server_copy ok", email)
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
