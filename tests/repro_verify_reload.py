"""Repro: log requestfailed events and console lines on /verify over 4 reloads.

    python tests/repro_verify_reload.py [--block-external]

--block-external aborts every non-local request (simulates a sandbox
without network) so the GitHub release-API failure path is visible.

Diagnostic only (no assertions). Starts the app from this checkout, opens
/verify in Chromium, reloads it 4 times and prints every requestfailed
event (resource type, URL, failure text), console message and page error,
plus the release-check status line after each load.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import free_port, start_server  # noqa: E402

STATUS_JS = """() => {
  const el = document.querySelector('[data-release-status], .release-status, #release-status, [id*="release"][id*="status"]');
  return el ? el.textContent.trim() : null;
}"""


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="verify-reload-"))
    port = free_port()
    proc = start_server(root, port)
    base = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context()
            if "--block-external" in sys.argv:
                ctx.route(
                    lambda u: not u.startswith(base),
                    lambda route: route.abort("failed"),
                )
            page = ctx.new_page()
            step = {"n": "goto"}
            page.on("requestfailed", lambda r: print(
                f"[{step['n']}] requestfailed {r.resource_type} {r.url} -> {r.failure}"))
            page.on("console", lambda m: print(f"[{step['n']}] console.{m.type}: {m.text}"))
            page.on("request", lambda r: print(f"[{step['n']}] request {r.url}")
                    if "api.github.com" in r.url else None)
            page.on("pageerror", lambda e: print(f"[{step['n']}] pageerror: {e}"))
            page.goto(base + "/verify", wait_until="networkidle")
            time.sleep(4)
            print("[goto] status:", page.evaluate(STATUS_JS))
            for i in range(1, 5):
                step["n"] = f"reload{i}"
                page.reload(wait_until="networkidle")
                time.sleep(4)
                print(f"[{step['n']}] status:", page.evaluate(STATUS_JS))
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
