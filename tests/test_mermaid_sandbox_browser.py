"""Mermaid diagrams: rendered inside a sandboxed iframe with no access to the app (real Chromium)."""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

import pytest

sync_api = pytest.importorskip("playwright.sync_api")

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"
JS = STATIC / "js"
SCRIPTS = [
    JS / "vendor" / "dompurify" / "purify.min.js",
    JS / "vendor" / "markdown-it" / "markdown-it.min.js",
    JS / "vendor" / "highlightjs" / "highlight.min.js",
    JS / "sanitize.js",
    JS / "markdown.js",
    JS / "mermaid-view.js",
    JS / "preview.js",
]
CSS = (STATIC / "css" / "app.css").read_text(encoding="utf-8")
FENCE = "```"
GOOD = "graph TD\n  A[Start] --> B[Einde]"


@pytest.fixture(scope="module")
def flask_app():
    """The real Flask app, so the sandbox page is served with the headers production sends."""
    tmp = tempfile.TemporaryDirectory()
    root = Path(tmp.name)
    (root / "keys").mkdir(parents=True)
    (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")
    env = {
        "NOTES_ROOT": str(root),
        "NOTES_DATA": str(root / "data"),
        "NOTES_KEYS": str(root / "keys"),
        "NOTES_ALLOWED_CIDRS": "127.0.0.1/32",
        "NOTES_SERVER_INFO_REFRESH": "0",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    sys.path.insert(0, str(ROOT / "app"))
    for name in [n for n in sys.modules if n == "app" or n.startswith("app.")]:
        sys.modules.pop(name, None)
    try:
        module = importlib.import_module("app")
        yield module.app.test_client()
    finally:
        sys.path.remove(str(ROOT / "app"))
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        tmp.cleanup()


@pytest.fixture(scope="module")
def browser():
    try:
        with sync_api.sync_playwright() as pw:
            try:
                b = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            yield b
            b.close()
    except Exception as exc:
        if isinstance(exc, pytest.skip.Exception):
            raise
        pytest.skip(f"Playwright not usable: {exc}")


def _open(browser, flask_app, requests=None, app_csp=False):
    ctx = browser.new_context(viewport={"width": 800, "height": 600})
    page = ctx.new_page()

    def handle(route):
        url = route.request.url
        if requests is not None:
            requests.append(url)
        path = url.split("localhost", 1)[1].split("?", 1)[0]
        if path.startswith("/static/"):
            resp = flask_app.get(path, environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
            headers = {k: v for k, v in resp.headers.items() if k.lower() != "content-length"}
            route.fulfill(status=resp.status_code, headers=headers, body=resp.data)
            return
        headers = {}
        if app_csp:
            shell = flask_app.get("/app", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
            headers["Content-Security-Policy"] = shell.headers["Content-Security-Policy"]
        route.fulfill(
            status=200,
            headers=headers,
            content_type="text/html",
            body='<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head>'
                 '<body><div id="preview"></div></body></html>',
        )

    page.route("**/*", handle)
    page.goto("http://localhost/")
    page.add_style_tag(content=CSS)
    page.evaluate("localStorage.setItem('vault-key', 'SECRET-KEY'); document.cookie = 'session=SECRET-COOKIE'")
    for script in SCRIPTS:
        if app_csp:  # the app CSP forbids inline scripts, so load them as the app does: from 'self'
            page.add_script_tag(url="/" + script.relative_to(ROOT / "app").as_posix())
        else:
            page.add_script_tag(content=script.read_text(encoding="utf-8"))
    return page


def _show(page, md):
    page.evaluate(
        """(md) => {
          const p = document.getElementById('preview');
          p.innerHTML = NotesMarkdown.render(md);
          NotesPreview.decorateCodeBlocks(p);
        }""", md)


def _settled(page):
    page.wait_for_selector("#preview .md-mermaid.is-rendered, #preview .md-mermaid.is-error", timeout=20000)


def test_mermaid_block_renders_as_diagram(browser, flask_app):
    page = _open(browser, flask_app)
    _show(page, f"voor\n\n{FENCE}mermaid\n{GOOD}\n{FENCE}\n\nna")
    _settled(page)
    info = page.evaluate(
        """() => {
          const f = document.querySelector('#preview .md-mermaid-frame');
          const box = document.querySelector('#preview .md-mermaid-box');
          return { sandbox: f.getAttribute('sandbox'), height: f.getBoundingClientRect().height,
                   role: box.getAttribute('role'), label: box.getAttribute('aria-label'),
                   hasPre: !!document.querySelector('#preview .md-mermaid-source pre') };
        }""")
    assert info["sandbox"] == "allow-scripts"
    assert info["height"] > 20
    assert info["role"] == "img" and "A[Start] --> B[Einde]" in info["label"]
    assert info["hasPre"]
    frame = page.query_selector("#preview .md-mermaid-frame").content_frame()
    assert frame.locator("svg").count() == 1
    assert "Start" in frame.locator("svg").text_content()


def test_diagram_renders_under_the_real_app_csp(browser, flask_app):
    """The page carries the CSP of the real app shell (frame-src 'self'), so the iframe must still load."""
    page = _open(browser, flask_app, app_csp=True)
    csp = page.evaluate("fetch(location.href).then(r => r.headers.get('content-security-policy'))")
    assert "frame-src 'self'" in csp and "'unsafe-inline'" not in csp.split("script-src")[1].split(";")[0]
    _show(page, f"{FENCE}mermaid\n{GOOD}\n{FENCE}")
    _settled(page)
    assert page.locator("#preview .md-mermaid.is-rendered").count() == 1
    frame = page.query_selector("#preview .md-mermaid-frame").content_frame()
    assert "Start" in frame.locator("svg").text_content()


def test_aria_label_of_a_large_diagram_is_truncated(browser, flask_app):
    page = _open(browser, flask_app)
    big = GOOD + "".join(f"\n  N{i} --> N{i + 1}" for i in range(300))
    _show(page, f"{FENCE}mermaid\n{big}\n{FENCE}")
    _settled(page)
    label = page.get_attribute("#preview .md-mermaid-box", "aria-label")
    assert len(big) > 1000 and len(label) < 400 and label.endswith("…")
    assert "A[Start] --> B[Einde]" in label


def test_sandbox_response_has_strict_headers(flask_app):
    resp = flask_app.get("/static/mermaid-sandbox.html", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    csp = resp.headers["Content-Security-Policy"]
    assert "default-src 'none'" in csp and "script-src 'self'" in csp
    assert "unsafe-eval" not in csp and "connect-src" not in csp
    assert resp.headers["X-Frame-Options"] == "SAMEORIGIN"


def test_invalid_diagram_shows_source_and_message(browser, flask_app):
    page = _open(browser, flask_app)
    _show(page, f"{FENCE}mermaid\nthis is not a diagram ((\n{FENCE}")
    _settled(page)
    assert page.locator("#preview .md-mermaid.is-error").count() == 1
    assert page.locator("#preview .md-mermaid-error").inner_text().startswith("Dit diagram kan niet")
    assert "this is not a diagram ((" in page.locator("#preview .md-mermaid pre").inner_text()
    assert page.locator("#preview iframe").count() == 0
    # The page keeps working: a following valid diagram still renders.
    _show(page, f"{FENCE}mermaid\n{GOOD}\n{FENCE}")
    _settled(page)
    assert page.locator("#preview .md-mermaid.is-rendered").count() == 1


def test_mermaid_loads_only_when_note_has_a_mermaid_block(browser, flask_app):
    requests = []
    page = _open(browser, flask_app, requests)
    _show(page, f"gewone tekst\n\n{FENCE}js\nconst a = 1;\n{FENCE}")
    page.wait_for_timeout(500)
    assert page.locator("#preview iframe").count() == 0
    assert not [u for u in requests if "mermaid" in u]
    _show(page, f"{FENCE}mermaid\n{GOOD}\n{FENCE}")
    _settled(page)
    assert [u for u in requests if u.endswith("/static/js/vendor/mermaid/mermaid.min.js")]


MALICIOUS = [
    "graph TD\n  A-->B\n  click A call alert(1)",
    'graph TD\n  A-->B\n  click A href "javascript:alert(1)"',
    '%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\ngraph TD\n  A["<img src=x onerror=parent.__pwned=1>"]-->B',
    'graph TD\n  A["<script>parent.__pwned=1</script>"]-->B',
]


@pytest.mark.parametrize("source", MALICIOUS)
def test_malicious_diagram_text_cannot_reach_the_app(browser, flask_app, source):
    page = _open(browser, flask_app)
    page.evaluate("window.__alerts = []; window.alert = (m) => window.__alerts.push(m); 0")
    before = page.evaluate("document.querySelectorAll('*').length")
    _show(page, f"{FENCE}mermaid\n{source}\n{FENCE}")
    _settled(page)
    page.wait_for_timeout(300)
    state = page.evaluate(
        """() => ({ pwned: window.__pwned === undefined ? null : window.__pwned, alerts: window.__alerts.length,
                    key: localStorage.getItem('vault-key'), cookie: document.cookie,
                    inlineSvg: !!document.querySelector('#preview svg'),
                    jsLinks: document.querySelectorAll('#preview [href^="javascript"], #preview [onerror], #preview [onclick]').length })""")
    assert state["pwned"] is None and state["alerts"] == 0
    assert state["key"] == "SECRET-KEY" and "SECRET-COOKIE" in state["cookie"]
    assert not state["inlineSvg"] and state["jsLinks"] == 0
    assert page.evaluate("document.querySelectorAll('*').length") - before < 20  # figure, frame, details only
    if page.locator("#preview .md-mermaid.is-rendered").count():
        frame = page.query_selector("#preview .md-mermaid-frame").content_frame()
        assert frame.locator("a[href^='javascript'], [onclick], [onerror], script:not([src]), foreignObject img").count() == 0


def test_code_in_the_iframe_cannot_touch_the_app(browser, flask_app):
    page = _open(browser, flask_app)
    _show(page, f"{FENCE}mermaid\n{GOOD}\n{FENCE}")
    _settled(page)
    frame = page.query_selector("#preview .md-mermaid-frame").content_frame()
    result = frame.evaluate(
        """async () => {
          const attempt = async (fn) => { try { return 'ALLOWED:' + String(await fn()); } catch (e) { return 'BLOCKED:' + e.name; } };
          return {
            parentDom: await attempt(() => window.parent.document.body.innerHTML),
            top: await attempt(() => window.top.document.title),
            local: await attempt(() => localStorage.getItem('vault-key')),
            cookie: await attempt(() => document.cookie),
            idb: await attempt(() => new Promise((res, rej) => { const r = indexedDB.open('x'); r.onsuccess = res; r.onerror = () => rej(r.error); })),
            fetchSelf: await attempt(() => fetch('/api/anything')),
            fetchOut: await attempt(() => fetch('https://example.com/')),
          };
        }""")
    parent_view = page.evaluate(
        """() => { try { return 'ALLOWED:' + document.querySelector('.md-mermaid-frame').contentDocument.body.innerHTML.length; }
                   catch (e) { return 'BLOCKED:' + e.name; } }""")
    assert parent_view.startswith("BLOCKED:"), (parent_view, result)
    for key in ("parentDom", "top", "local", "cookie", "idb", "fetchSelf", "fetchOut"):
        assert result[key].startswith("BLOCKED:"), (key, result[key])


def test_forged_messages_are_ignored(browser, flask_app):
    page = _open(browser, flask_app)
    page.evaluate("""() => { window.postMessage({ type: 'dg-mermaid-result', id: 'm1', height: 3 }, '*'); }""")
    page.evaluate("""() => { window.postMessage({ type: 'dg-mermaid-result', id: 'm1', error: 'x' }, '*'); }""")
    _show(page, f"{FENCE}mermaid\n{GOOD}\n{FENCE}")
    _settled(page)
    assert page.locator("#preview .md-mermaid.is-rendered").count() == 1
    height = page.evaluate("document.querySelector('#preview .md-mermaid-frame').getBoundingClientRect().height")
    assert height > 20
