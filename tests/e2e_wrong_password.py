"""End-to-end: a wrong vault password must not wipe the local cache.

Seeds a vault, locks, unlocks with a wrong password and asserts:
  - the IndexedDB ciphertext rows are preserved (no pre-proof wipe),
  - the vault ends locked with the lock screen visible and an error message,
Then unlocks with the right password and asserts the notes are back
without needing a full re-download.

Run directly when Chromium and chromedriver are installed:

    E2E_WRONGPW=1 python tests/e2e_wrong_password.py
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
OUT_DIR = Path(os.environ.get("E2E_OUT", "/tmp/notes-e2e-wrongpw"))
EMAIL = "wrongpw@home.local"
PASSWORD = "wrongpw-right-password-1234"
WRONG = "wrongpw-wrong-password-9999"


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
        FLASK_APP="app",
        PYTHONPATH=str(APP_DIR),
    )
    (root / "keys").mkdir(parents=True, exist_ok=True)
    (root / "keys" / "flask-secret").write_text("e2e-wrongpw-secret", encoding="utf-8")
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


def make_driver(profile: Path):
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service

    opts = Options()
    opts.binary_location = "/usr/bin/chromium"
    opts.set_capability("goog:loggingPrefs", {"browser": "SEVERE"})
    for flag in (
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        f"--user-data-dir={profile}",
        "--window-size=1280,900",
    ):
        opts.add_argument(flag)
    driver = webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=opts)
    driver.set_script_timeout(120)
    return driver


def cipher_count(driver) -> int:
    return driver.execute_async_script(
        "const cb = arguments[arguments.length-1];"
        " NotesStore.localCipherCount().then(cb).catch((e) => cb(-1));"
    )


def unlock_with(driver, wait, password) -> None:
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.common.by import By
    wait.until(EC.visibility_of_element_located((By.ID, "unlock-screen")))
    driver.execute_script(
        "const f = document.getElementById('unlock-password');"
        " f.value = arguments[0];"
        " f.dispatchEvent(new Event('input', { bubbles: true }));"
        " document.getElementById('unlock-submit').click();",
        password,
    )


def main() -> int:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="notes-e2e-wrongpw-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    profile = OUT_DIR / "profile"
    shutil.rmtree(profile, ignore_errors=True)
    driver = make_driver(profile)
    wait = WebDriverWait(driver, 60)
    try:
        driver.get(f"{base}/register")
        driver.find_element(By.NAME, "email").send_keys(EMAIL)
        driver.find_element(By.NAME, "password").send_keys(PASSWORD)
        driver.find_element(By.NAME, "password2").send_keys(PASSWORD)
        driver.find_element(By.CSS_SELECTOR, "#register-form button[type=submit]").click()
        wait.until(EC.presence_of_element_located((By.ID, "app")))
        wait.until(lambda d: d.execute_script(
            "return !!window.NotesStore && NotesStore.isUnlocked();"))
        driver.execute_script(
            "for (const t of ['W one', 'W two', 'W three']) {"
            " const id = NotesStore.newUuid();"
            " NotesStore.upsert(id, {...NotesStore.defaultNote(), title: t, content: 'body ' + t});"
            "}")
        driver.execute_script("return NotesStore.sync({full: true});")
        time.sleep(2)
        assert driver.execute_script("return NotesStore.listNotes().length;") == 3
        assert cipher_count(driver) == 3, "seed did not persist 3 cipher rows"

        driver.get(f"{base}/")
        unlock_with(driver, wait, WRONG)
        # Wrong password must fail closed: lock screen stays with an error,
        # and the local ciphertext rows must be preserved. The vault reports
        # unlocked while a probe is in flight (key is set before proof), so
        # wait for a SETTLED state: revealed app (success) or the submit
        # button back to 'Unlock' (failure).
        WebDriverWait(driver, 180).until(lambda d: d.execute_script(
            "return (NotesStore.isUnlocked() && document.getElementById('unlock-screen').hidden)"
            " || document.getElementById('unlock-submit').textContent === 'Unlock';"))
        time.sleep(1)
        locked = driver.execute_script(
            "return { unlocked: NotesStore.isUnlocked(),"
            " unlockHidden: document.getElementById('unlock-screen').hidden,"
            " err: document.getElementById('unlock-error').textContent };")
        assert not locked["unlocked"], f"vault unlocked with wrong password: {locked}"
        assert locked["unlockHidden"] is False, f"lock screen hidden: {locked}"
        assert locked["err"].strip(), "no unlock error message shown"
        assert cipher_count(driver) == 3, "local cache was wiped by wrong password"

        unlock_with(driver, wait, PASSWORD)
        wait.until(lambda d: d.execute_script("return NotesStore.listNotes().length;") >= 3)
        assert cipher_count(driver) == 3
        print("wrong-password e2e: PASS (cache preserved, lock screen shown, recovery works)")
        return 0
    finally:
        try:
            driver.save_screenshot(str(OUT_DIR / "wrongpw-final.png"))
        except Exception:
            pass
        driver.quit()
        proc.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
