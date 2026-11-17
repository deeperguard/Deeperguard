"""Formatted Markdown editor (app/static/js/rich-editor.js on the vendored CodeMirror bundle) in real
Chromium: byte-exact round-trip over a corpus, toolbar actions and shortcuts, multi-step undo/redo,
pasted-HTML sanitizing, toolbar keyboard use and typing speed on a large note.
Run by tests/test_rich_editor.js (also directly with pytest)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

sync_api = pytest.importorskip("playwright.sync_api")

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "app" / "static" / "js"
SCRIPTS = [
    JS / "vendor" / "codemirror" / "codemirror.min.js",
    JS / "vendor" / "dompurify" / "purify.min.js",
    JS / "sanitize.js",
    JS / "table-editor.js",
    JS / "rich-editor.js",
]

CSS = (ROOT / "app" / "static" / "css" / "app.css").read_text(encoding="utf-8")

HOSTILE = [
    "",
    "\n",
    "a",
    "line one\r\nline two\r\n\r\n| a | b |\r\n| - | - |\r\n",
    "\tindented\twith\ttabs\n\t- nested\n\t\t- deeper\n",
    "---\ntitle: front matter\ntags: [a, b]\n---\n\n# Body\n",
    "Setext heading\n==============\n\nSub\n---\n",
    "text with trailing spaces  \nhard break above\\\nbackslash break<br>html br\n",
    "<div class=\"x\">\n  <script>alert(1)</script>\n</div>\n\n<details><summary>s</summary>\n\nhidden *md*\n\n</details>\n",
    "Footnote[^1] and $$ x^2 $$ and [[wiki link]] and [id:note-123]\n\n[^1]: the note\n",
    "term\n: definition\n\n```mermaid\ngraph TD; A-->B\n```\n\n~~~python\nprint('x')\n~~~\n",
    "1. one\n1. one again\n3. three\n* star\n+ plus\n- dash\n  * nested star\n",
    "| broken | table\n|---|\n| only one cell |\n\n| a | b |\n|:--|--:|\n| x\\|y | z |\n",
    "Ünïcødé 日本語 🙂 العربية\n​zero width nbsp\n",
    "* * *\n___\n- [ ] task\n- [x] done\n> quote\n> > nested\n",
    "unterminated ```fence\n```\nnever closed\n",
    "**bold *and italic* text** and `code` and ~~strike~~ and [link](https://example.org) and <https://auto.link>\n",
    ("# Big\n\n" + "A paragraph with **bold**, *italic*, `code` and a [link](https://example.org/x).\n\n" * 12000),
]


def _corpus() -> list[str]:
    texts = list(HOSTILE)
    files = sorted((ROOT / "docs").rglob("*.md")) + [ROOT / "README.md", ROOT / "SECURITY.md"]
    for path in files:
        texts.append(path.read_text(encoding="utf-8"))
    return texts


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


@pytest.fixture()
def page(browser):
    pg = browser.new_page()
    pg.set_content('<style>' + CSS + '</style><div id="host" class="note-rich"></div><div id="tb"><button>A</button><button hidden>H</button><button>B</button><button disabled>D</button><button>C</button></div>')
    for script in SCRIPTS:
        pg.add_script_tag(content=script.read_text(encoding="utf-8"))
    pg.evaluate(
        """() => {
          window.changes = [];
          window.ctl = NotesRichEditor.create(document.getElementById('host'), {
            doc: '', onChange: (t) => window.changes.push(t),
          });
        }"""
    )
    yield pg
    pg.close()


def _set(page, text, start=None, end=None):
    page.evaluate(
        """([text, start, end]) => {
          ctl.setValue(text, { reset: true });
          const s = start ?? text.length;
          ctl.view.dispatch({ selection: { anchor: s, head: end ?? s } });
          ctl.view.focus();
        }""",
        [text, start, end],
    )


def _value(page):
    return page.evaluate("() => ctl.getValue()")


def test_round_trip_is_byte_for_byte_over_corpus(page):
    corpus = _corpus()
    assert len(corpus) > 25
    bad = page.evaluate(
        """(corpus) => {
          const bad = [];
          corpus.forEach((text, i) => {
            ctl.setValue(text, { reset: true });
            if (ctl.getValue() !== text) bad.push(['open', i]);
            // switching the mode away and back: the app hands the same string over again
            ctl.setValue(text + 'x');
            ctl.setValue(text);
            if (ctl.getValue() !== text) bad.push(['switch', i]);
          });
          return bad;
        }""",
        corpus,
    )
    assert bad == []
    assert page.evaluate("() => window.changes.length") == 0, "loading a note must not report a change"


def test_one_edit_changes_only_the_edited_text(page):
    source = "# Title\n\nkeep  this   exact\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\nplain *emph* and word here\n"
    start = source.index("word")
    _set(page, source, start, start + 4)
    page.keyboard.press("Control+b")
    assert _value(page) == source.replace("word", "**word**")
    assert page.evaluate("() => window.changes.length") == 1


def test_live_preview_hides_markers_off_the_cursor_line_only(page):
    _set(page, "plain\n\n**bold** and `code`\n\n## Head\n", 0, 0)
    off = page.evaluate("() => [...document.querySelectorAll('.cm-line')].map((l) => l.textContent)")
    assert off[2] == "bold and code" and off[4] == "Head"
    assert page.evaluate("() => !!document.querySelector('.dg-b') && !!document.querySelector('.dg-h2')")
    page.evaluate("() => ctl.view.dispatch({ selection: { anchor: 10 } })")
    on = page.evaluate("() => [...document.querySelectorAll('.cm-line')].map((l) => l.textContent)")
    assert on[2] == "**bold** and `code`"


@pytest.mark.parametrize(
    "keys,source,sel,expected",
    [
        ("Control+b", "a word b", (2, 6), "a **word** b"),
        ("Control+i", "a word b", (2, 6), "a *word* b"),
        ("Control+e", "a word b", (2, 6), "a `word` b"),
        ("Control+Shift+x", "a word b", (2, 6), "a ~~word~~ b"),
        ("Control+k", "a word b", (2, 6), "a [word](https://) b"),
        ("Control+b", "a **word** b", (4, 8), "a word b"),
        ("Control+Alt+1", "title", (0, 0), "# title"),
        ("Control+Alt+2", "# title", (0, 0), "## title"),
        ("Control+Alt+2", "## title", (0, 0), "title"),
        ("Control+Shift+8", "one\ntwo", (0, 7), "- one\n- two"),
        ("Control+Shift+7", "one\ntwo", (0, 7), "1. one\n2. two"),
        ("Control+Shift+9", "one", (0, 0), "- [ ] one"),
        ("Control+Shift+8", "- one\n- two", (0, 11), "one\ntwo"),
    ],
)
def test_shortcuts(page, keys, source, sel, expected):
    _set(page, source, *sel)
    page.keyboard.press(keys)
    assert _value(page) == expected


@pytest.mark.parametrize(
    "action,source,sel,expected",
    [
        ("bold", "", (0, 0), "****"),
        ("italic", "x", (0, 1), "*x*"),
        ("strike", "x", (0, 1), "~~x~~"),
        ("quote", "a\nb", (0, 3), "> a\n> b"),
        ("quote", "> a", (0, 0), "a"),
        ("ol", "a\nb", (0, 3), "1. a\n2. b"),
        ("check", "- a", (0, 0), "- [ ] a"),
        ("codeblock", "", (0, 0), "```\n\n```"),
        ("codeblock", "x = 1", (0, 5), "```\nx = 1\n```"),
        ("link", "see https://example.org", (4, 23), "see [link](https://example.org)"),
        ("h3", "t", (0, 0), "### t"),
    ],
)
def test_toolbar_actions(page, action, source, sel, expected):
    _set(page, source, *sel)
    assert page.evaluate("(a) => ctl.exec(a)", action) is True
    assert _value(page) == expected


def test_table_action_inserts_gfm_table(page):
    _set(page, "intro", 5, 5)
    page.evaluate("() => ctl.exec('table')")
    value = _value(page)
    assert value.startswith("intro\n\n| Column 1 | Column 2 |\n| --- | --- |\n")
    assert page.evaluate("() => document.querySelectorAll('.dg-table').length") == 4


def test_enter_continues_and_ends_lists(page):
    _set(page, "- [ ] one", 9, 9)
    page.keyboard.press("Enter")
    page.keyboard.type("two")
    assert _value(page) == "- [ ] one\n- [ ] two"
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    assert _value(page) == "- [ ] one\n- [ ] two\n"
    _set(page, "9. nine", 7, 7)
    page.keyboard.press("Enter")
    assert _value(page) == "9. nine\n10. "


def test_task_checkbox_widget_toggles_the_source(page):
    _set(page, "- [ ] todo\n\nother", 16, 16)
    page.locator(".dg-task").click()
    assert _value(page) == "- [x] todo\n\nother"
    assert page.locator(".dg-task").get_attribute("aria-checked") == "true"


def test_undo_redo_over_several_steps(page):
    _set(page, "alpha beta gamma", 0, 5)
    page.keyboard.press("Control+b")
    page.evaluate("() => ctl.view.dispatch({ selection: { anchor: 10, head: 14 } })")  # "beta" after the bold markers
    page.keyboard.press("Control+i")
    page.evaluate("() => ctl.exec('h1')")
    steps = [_value(page)]
    assert steps[0] == "# **alpha** *beta* gamma"
    page.keyboard.press("Control+z")
    assert _value(page) == "**alpha** *beta* gamma"
    page.keyboard.press("Control+z")
    assert _value(page) == "**alpha** beta gamma"
    page.keyboard.press("Control+z")
    assert _value(page) == "alpha beta gamma"
    assert page.evaluate("() => [ctl.canUndo(), ctl.canRedo()]") == [False, True]
    page.keyboard.press("Control+y")
    page.keyboard.press("Control+Shift+z")
    assert _value(page) == "**alpha** *beta* gamma"
    page.evaluate("() => ctl.redo()")
    assert _value(page) == "# **alpha** *beta* gamma"
    page.evaluate("() => { ctl.undo(); ctl.undo(); }")
    assert _value(page) == "**alpha** beta gamma"


def test_new_note_drops_the_old_undo_history(page):
    _set(page, "one")
    page.keyboard.type(" two")
    _set(page, "other note")
    assert page.evaluate("() => ctl.canUndo()") is False


def _paste(page, html, text=""):
    page.evaluate(
        """([html, text]) => {
          const dt = new DataTransfer();
          dt.setData('text/html', html);
          if (text) dt.setData('text/plain', text);
          ctl.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }""",
        [html, text],
    )


def test_paste_html_becomes_clean_markdown(page):
    _set(page, "")
    _paste(
        page,
        '<h2>Plan</h2><p>Some <b>bold</b>, <i>it</i>, <s>old</s> and <code>x</code> with a <a href="https://example.org/a b">link</a>.</p>'
        "<ul><li>one<ul><li>nested</li></ul></li><li><input type=checkbox checked> done</li></ul>"
        "<ol><li>first</li><li>second</li></ol><blockquote><p>quoted</p></blockquote>"
        '<pre><code class="language-js">let a = 1;\n</code></pre>'
        "<table><tr><th>H1</th><th>H2</th></tr><tr><td>a|b</td><td>c</td></tr></table>",
    )
    assert _value(page) == (
        "## Plan\n\n"
        "Some **bold**, *it*, ~~old~~ and `x` with a [link](https://example.org/a%20b).\n\n"
        "- one\n  - nested\n- [x] done\n\n"
        "1. first\n2. second\n\n"
        "> quoted\n\n"
        "```js\nlet a = 1;\n```\n\n"
        "| H1 | H2 |\n| --- | --- |\n| a\\|b | c |"
    )
    assert page.evaluate("() => ctl.canUndo()") is True


MALICIOUS = [
    '<p>safe</p><script>window.__pwned = 1; alert(1)</script>',
    '<p onclick="window.__pwned=1">click <img src=x onerror="window.__pwned=1"> me</p>',
    '<a href="javascript:window.__pwned=1">js link</a> <a href=" jAvAsCrIpT:alert(1)">js2</a> <a href="data:text/html,<script>1</script>">data</a> <a href="vbscript:x">vb</a>',
    '<style>body{background:url(https://tracker.example/x)}</style><p style="background:url(https://tracker.example/y)">styled</p>',
    '<img src="https://tracker.example/pixel.gif" width=1 height=1><p>after pixel</p>',
    '<svg onload="window.__pwned=1"><circle/></svg><iframe src="https://evil.example"></iframe><object data="x"></object>',
    '<form action="https://evil.example"><input name=a><button formaction="javascript:1">go</button></form>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math><noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<a href="https://ok.example/" onmouseover="window.__pwned=1" target="_blank">ok link</a>',
]


@pytest.mark.parametrize("html", MALICIOUS)
def test_pasted_malicious_html_yields_clean_markdown(page, html):
    _set(page, "start: ")
    page.evaluate("() => { window.__pwned = 0; }")
    _paste(page, html)
    value = _value(page)
    lowered = value.lower()
    for bad in ("<script", "<style", "<img", "<svg", "<iframe", "<object", "<form", "onerror", "onclick", "onload",
                "onmouseover", "javascript:", "vbscript:", "data:text", "tracker.example", "evil.example", "alert(", "__pwned"):
        assert bad not in lowered, (bad, value)
    # no raw HTML or style left; links are only markdown links with an allowed scheme
    assert "<" not in value.replace("\\<", "")
    for url in __import__("re").findall(r"\]\(([^)]*)\)", value):
        assert url.startswith(("https://", "http://", "mailto:")), url
    assert page.evaluate("() => window.__pwned") == 0
    assert value.startswith("start: ")


def test_paste_keeps_readable_text_of_unsafe_markup(page):
    _set(page, "")
    _paste(page, '<p>safe</p><a href="javascript:alert(1)">js link</a><img src=x onerror=alert(1)>')
    assert _value(page) == "safe\n\njs link"


def test_paste_without_html_inserts_the_plain_text_verbatim(page):
    _set(page, "")
    page.evaluate(
        """() => {
          const dt = new DataTransfer();
          dt.setData('text/plain', '**plain** <b>text</b>\\n- item');
          ctl.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }"""
    )
    assert _value(page) == "**plain** <b>text</b>\n- item"


def _paste_plain(page, text):
    page.evaluate(
        """(text) => {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          ctl.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }""",
        text,
    )


def test_paste_into_a_crlf_note_uses_crlf(page):
    _set(page, "a\r\nb\r\n")
    page.evaluate("() => ctl.view.dispatch({ selection: { anchor: ctl.view.state.doc.length } })")
    _paste_plain(page, "x\ny\r\nz")
    assert _value(page) == "a\r\nb\r\nx\r\ny\r\nz"


def test_paste_into_an_lf_note_uses_lf(page):
    _set(page, "a\nb\n")
    page.evaluate("() => ctl.view.dispatch({ selection: { anchor: ctl.view.state.doc.length } })")
    _paste_plain(page, "x\r\ny\nz")
    assert _value(page) == "a\nb\nx\ny\nz"


def test_toolbar_roles_and_keyboard(page):
    page.evaluate("() => NotesRichEditor.attachToolbar(document.getElementById('tb'), 'Formatting')")
    assert page.get_attribute("#tb", "role") == "toolbar"
    assert page.get_attribute("#tb", "aria-label") == "Formatting"
    tabs = page.evaluate("() => [...document.querySelectorAll('#tb button')].map((b) => b.tabIndex)")
    assert tabs.count(0) == 1
    page.focus("#tb button >> nth=0")
    page.keyboard.press("ArrowRight")
    assert page.evaluate("() => document.activeElement.textContent") == "B"  # skips hidden and disabled
    page.keyboard.press("ArrowRight")
    assert page.evaluate("() => document.activeElement.textContent") == "C"
    page.keyboard.press("ArrowRight")
    assert page.evaluate("() => document.activeElement.textContent") == "A"
    page.keyboard.press("End")
    assert page.evaluate("() => document.activeElement.textContent") == "C"
    page.keyboard.press("Home")
    assert page.evaluate("() => document.activeElement.textContent") == "A"
    assert page.evaluate("() => [...document.querySelectorAll('#tb button')].filter((b) => b.tabIndex === 0).length") == 1


def test_editor_is_a_labelled_textbox_and_read_only_blocks_edits(page):
    attrs = page.evaluate(
        "() => { const c = ctl.view.contentDOM; return [c.getAttribute('role'), c.getAttribute('aria-multiline'), c.getAttribute('aria-label')]; }"
    )
    assert attrs == ["textbox", "true", "Note text, formatted"]
    _set(page, "fixed")
    page.evaluate("() => ctl.setReadOnly(true)")
    page.keyboard.type("zzz")
    assert _value(page) == "fixed"
    page.evaluate("() => { ctl.setReadOnly(false); ctl.focus(); }")
    page.keyboard.type("!")
    assert _value(page) == "fixed!"


def test_typing_stays_fast_in_a_large_note(page):
    big = ("Paragraph with **bold**, *italic*, `code` and a [link](https://example.org/x) in it.\n\n" * 5000)[:400000]
    assert not page.evaluate("(t) => NotesRichEditor.tooLarge(t)", big)
    assert page.evaluate("(t) => NotesRichEditor.tooLarge(t)", "x" * 500001)
    assert page.evaluate("(t) => NotesRichEditor.tooLarge(t)", "x\n" * 20001)
    _set(page, big, 200000, 200000)
    ms = page.evaluate(
        """async () => {
          const times = [];
          for (let i = 0; i < 40; i += 1) {
            const t0 = performance.now();
            ctl.view.dispatch(ctl.view.state.update({ changes: { from: ctl.view.state.selection.main.head, insert: 'x' }, selection: { anchor: ctl.view.state.selection.main.head + 1 }, userEvent: 'input.type' }));
            ctl.view.measure();
            times.push(performance.now() - t0);
          }
          times.sort((a, b) => a - b);
          return times[Math.floor(times.length / 2)];
        }"""
    )
    assert ms < 50, f"median keystroke {ms:.1f} ms"
