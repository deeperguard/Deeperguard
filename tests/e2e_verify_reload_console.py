"""E2E: /verify reloaded 3 times must not log failures of own-origin resources.

    python tests/e2e_verify_reload_console.py

Own-origin failures (requestfailed, console errors located on the app origin,
uncaught page errors) fail the test. Requests to other origins are judged
separately: they are blocked here (sandbox without network), the browser logs
them, and that is tolerated only because the page must then say honestly that
it could not check.

Self-test: the same checker must report a failure when marketing.js gets a
wrong integrity hash or does not load.
"""
from __future__ import annotations

import re
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import free_port, start_server  # noqa: E402

RELOADS = 3
STATUS_SEL = "#verify-release-hash-status"
BAD_INTEGRITY = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
SCRIPT_TAG = re.compile(r"<script\b[^>]*marketing[^>]*>", re.I)
INTEGRITY_ATTR = re.compile(r'integrity="[^"]*"')


def tamper_integrity(route):
    resp = route.fetch()
    body = resp.text()
    if not any("integrity=" in t for t in SCRIPT_TAG.findall(body)):
        raise AssertionError("marketing.js script tag has no integrity attribute")
    body = SCRIPT_TAG.sub(
        lambda m: INTEGRITY_ATTR.sub(f'integrity="{BAD_INTEGRITY}"', m.group(0)), body)
    route.fulfill(response=resp, body=body)


def run_scenario(base: str, browser, mutate=None, wait_status=True) -> tuple[list[str], str]:
    """Open /verify, reload RELOADS times; return (own-origin problems, status)."""
    origin = urlparse(base).netloc
    problems: list[str] = []
    status = ""
    ctx = browser.new_context()
    # Sandbox without network: every foreign request fails.
    ctx.route(lambda u: urlparse(u).netloc != origin, lambda r: r.abort("failed"))
    if mutate:
        mutate(ctx)
    page = ctx.new_page()
    step = {"n": "goto"}

    def own(url: str) -> bool:
        return urlparse(url).netloc == origin

    def on_failed(r):
        if own(r.url):
            problems.append(f"[{step['n']}] requestfailed {r.url}: {r.failure}")

    def on_console(m):
        url = m.location.get("url", "")
        # An empty url counts as own origin, except for the blocked github call.
        if m.type == "error" and (own(url) if url else "api.github.com" not in m.text):
            problems.append(f"[{step['n']}] console.error: {m.text} ({url})")

    page.on("requestfailed", on_failed)
    page.on("console", on_console)
    page.on("pageerror", lambda e: problems.append(f"[{step['n']}] pageerror: {e}"))
    page.goto(base + "/verify", wait_until="load")
    for i in range(1, RELOADS + 1):
        step["n"] = f"reload{i}"
        page.reload(wait_until="load")
        if not wait_status:
            continue
        page.wait_for_function(
            "s => { const e = document.querySelector(s);"
            " return e && !/Checking/.test(e.textContent); }",
            arg=STATUS_SEL, timeout=40000)
        status = page.locator(STATUS_SEL).inner_text().strip()
    ctx.close()
    return problems, status


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="verify-reload-console-"))
    port = free_port()
    proc = start_server(root, port)
    base = f"http://127.0.0.1:{port}"
    failures: list[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            problems, status = run_scenario(base, browser)
            if problems:
                failures.append("own-origin problems on /verify:\n  " + "\n  ".join(problems))
            if "Could not check" not in status:
                failures.append(f"offline status line is not honest: {status!r}")

            def bad_hash(ctx):
                ctx.route(re.compile(r".*/verify$"), tamper_integrity)

            problems, _ = run_scenario(base, browser, bad_hash, wait_status=False)
            if not problems:
                failures.append("self-test: wrong integrity on marketing.js went unnoticed")

            def no_marketing(ctx):
                ctx.route(re.compile(r".*marketing[^/]*\.js(\?.*)?$"),
                          lambda r: r.abort("failed"))

            problems, _ = run_scenario(base, browser, no_marketing, wait_status=False)
            if not problems:
                failures.append("self-test: unloadable marketing.js went unnoticed")
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(root, ignore_errors=True)
    if failures:
        print("FAIL\n" + "\n".join(failures))
        return 1
    print(f"OK: /verify reloaded {RELOADS}x without own-origin failures; "
          "bad integrity and missing marketing.js are detected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
