"""Find-in-note highlighting in a real browser DOM.

Marks hits in a preview element with NotesSearch.applyHighlights (the call the
note find bar makes) for hostile search terms and checks: the term is matched
literally, only text nodes are wrapped in <mark>, no element or script comes
from the term, and no network request is made.

Called by tests/test_find_in_note.js. Exit 0 = pass, 1 = failures or a missing
prerequisite (Playwright or Chromium). A missing prerequisite is never a skip.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEARCH_JS = ROOT / "app" / "static" / "js" / "search.js"

CHECK = r"""
() => {
  const failures = [];
  const preview = document.getElementById('preview');
  const opts = { literal: true, foldAccents: true };
  const cases = [
    { term: '<img src=x onerror="window.__xss=1">', body: 'before <img src=x onerror="window.__xss=1"> after', hits: 1 },
    { term: '.*', body: 'plain text with a.* and b.*', hits: 2 },
    { term: '<script>window.__xss=2</script>', body: 'x <script>window.__xss=2</script> x', hits: 1 },
    { term: 'CAFE', body: 'Café cafe CAFÉ', hits: 3 },
    { term: 'zzz', body: 'nothing here', hits: 0 },
  ];
  for (const c of cases) {
    preview.textContent = c.body;
    const before = preview.querySelectorAll('*').length;
    const n = NotesSearch.applyHighlights(preview, c.term, opts);
    const marks = [...preview.querySelectorAll('mark.search-hit')];
    if (n !== c.hits || marks.length !== c.hits) failures.push(`${c.term}: ${n}/${marks.length} hits, wanted ${c.hits}`);
    if (preview.querySelectorAll('*').length !== before + marks.length) failures.push(`${c.term}: elements other than <mark> appeared`);
    if (preview.textContent !== c.body) failures.push(`${c.term}: text changed`);
    for (const m of marks) if (m.children.length) failures.push(`${c.term}: mark has child elements`);
  }
  // The highlighted-HTML helper must escape the term and the text.
  const html = NotesSearch.highlightPlain('a <b>x</b> .*', '<b>', opts);
  if (html.includes('<b>') || !html.includes('<mark class="search-hit">&lt;b&gt;</mark>')) failures.push(`highlightPlain: ${html}`);
  preview.innerHTML = html;
  if (preview.querySelector('b')) failures.push('highlightPlain produced a <b> element');
  return failures;
}
"""


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright is not installed")
        return 1
    requests: list[str] = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:
            print(f"chromium cannot start: {exc}")
            return 1
        try:
            page = browser.new_page()
            page.on("request", lambda req: requests.append(req.url))
            page.set_content('<!doctype html><html><body><div id="preview"></div></body></html>')
            page.add_script_tag(content=SEARCH_JS.read_text(encoding="utf-8"))
            failures = page.evaluate(CHECK)
            page.wait_for_timeout(100)
            if page.evaluate("window.__xss") is not None:
                failures.append("a script ran (window.__xss set)")
        finally:
            browser.close()
    external = [u for u in requests if not u.startswith(("about:", "data:"))]
    if external:
        failures.append(f"find made network requests: {external}")
    if failures:
        print("\n".join(failures))
        return 1
    print("find in note: real DOM ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
