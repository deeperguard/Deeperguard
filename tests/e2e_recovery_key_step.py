"""Finish the required recovery key step that a new account sees after registration.

Browser tests that register through /register call this right after the vault
unlocks; the step blocks the app until the key is confirmed (docs/VAULT_RECOVERY.md 5.1).
"""
from __future__ import annotations

DIALOG_OPEN = "#recovery-key-dialog:not([hidden])"


def read_shown_key(page, timeout: int = 60000) -> tuple[str, int]:
    """Wait for the step and return (recovery key text, group number asked for)."""
    page.wait_for_selector(DIALOG_OPEN, timeout=timeout)
    key = (page.text_content("#recovery-key-value") or "").strip()
    group = int((page.text_content("#recovery-key-group-number") or "0").strip())
    return key, group


def complete_recovery_key_step_selenium(driver, timeout: int = 60) -> None:
    """Same step for the Selenium-driven tests."""
    from selenium.webdriver.support.ui import WebDriverWait

    WebDriverWait(driver, timeout).until(lambda d: d.execute_script(
        "const d = document.getElementById('recovery-key-dialog');"
        "return !!d && !d.hidden && document.getElementById('recovery-key-value').textContent.length > 30;"
    ))
    driver.execute_script(
        """
        const key = document.getElementById('recovery-key-value').textContent.trim();
        const n = Number(document.getElementById('recovery-key-group-number').textContent);
        document.getElementById('recovery-key-stored').checked = true;
        document.getElementById('recovery-key-confirm-group').value = key.split('-')[n - 1];
        document.getElementById('recovery-key-save').click();
        """
    )
    WebDriverWait(driver, timeout).until(
        lambda d: d.execute_script("return document.getElementById('recovery-key-dialog').hidden;")
    )


def complete_recovery_key_step(page, timeout: int = 60000) -> str:
    key, group = read_shown_key(page, timeout)
    page.check("#recovery-key-stored")
    page.fill("#recovery-key-confirm-group", key.split("-")[group - 1])
    page.click("#recovery-key-save")
    try:
        page.wait_for_selector("#recovery-key-dialog", state="hidden", timeout=timeout)
    except Exception as exc:
        raise AssertionError(
            f"recovery key step did not finish: {page.text_content('#recovery-key-error')!r}"
        ) from exc
    return key
