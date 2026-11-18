"""Evernote (.enex) import, run in real Chromium (DOMParser): mapping, strict XML, sanitising, no network.

Spec: docs/IMPORT_EXPORT_SPEC.md 3.2, 4.1, 4.3, 4.5. Skipped when Playwright or Chromium is missing.
"""
from __future__ import annotations

import base64
import hashlib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "app" / "static" / "js" / "enex-import.js"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")
EN_EXPORT_DOCTYPE = '<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">'
EN_NOTE_DOCTYPE = '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">'


def enml(body: str, doctype: str = EN_NOTE_DOCTYPE) -> str:
    return f'<?xml version="1.0" encoding="UTF-8"?>{doctype}<en-note>{body}</en-note>'


def resource(data: bytes, mime: str, file_name: str = "") -> str:
    attrs = f"<resource-attributes><file-name>{file_name}</file-name></resource-attributes>" if file_name else ""
    return (f'<resource><data encoding="base64">{base64.b64encode(data).decode()}</data>'
            f"<mime>{mime}</mime>{attrs}</resource>")


def note(title: str, body: str, extra: str = "", doctype: str = EN_NOTE_DOCTYPE) -> str:
    return (f"<note><title>{title}</title><content><![CDATA[{enml(body, doctype)}]]></content>"
            f"<created>20240102T030405Z</created><updated>20240203T040506Z</updated>{extra}</note>")


def enex(*notes: str, doctype: str = EN_EXPORT_DOCTYPE) -> str:
    return f'<?xml version="1.0" encoding="UTF-8"?>{doctype}<en-export export-date="20240301T000000Z">{"".join(notes)}</en-export>'


PARSE = """
async ({ files }) => {
  const enc = new TextEncoder();
  const input = files.map((f) => ({ name: f.name, bytes: enc.encode(f.text) }));
  try {
    const r = await NotesEnexImport.parse(input, { now: new Date('2024-06-01T00:00:00Z') });
    return { ok: true, notes: r.notes.map((n) => ({ ...n, attachments: n.attachments.map((a) => ({ name: a.name, mime: a.mime, size: a.bytes.length, b64: btoa(String.fromCharCode(...a.bytes)) })) })),
             skipped: r.skipped, attachmentCount: r.attachmentCount };
  } catch (err) { return { ok: false, error: err.message }; }
}
"""


class EnexImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright is not installed")
        cls._pw = sync_playwright().start()
        try:
            cls._browser = cls._pw.chromium.launch()
        except Exception as exc:  # no Chromium binary
            cls._pw.stop()
            raise unittest.SkipTest(f"chromium cannot start: {exc}")
        cls.page = cls._browser.new_page()
        cls.requests: list[str] = []
        cls.page.on("request", lambda req: cls.requests.append(req.url))
        cls.page.set_content("<!doctype html><html><body></body></html>")
        cls.page.add_script_tag(content=SCRIPT.read_text(encoding="utf-8"))
        cls.requests.clear()

    @classmethod
    def tearDownClass(cls):
        cls._browser.close()
        cls._pw.stop()

    def parse(self, *texts: str, name: str = "export.enex") -> dict:
        files = [{"name": name if i == 0 else f"more{i}.enex", "text": t} for i, t in enumerate(texts)]
        return self.page.evaluate(PARSE, {"files": files})

    def test_note_with_tags_image_todo_and_attachment(self):
        digest = hashlib.md5(PNG).hexdigest()
        pdf = b"%PDF-1.4 fake"
        body = (
            '<div><b>Hello</b> <i>world</i> &lt;b&gt; <a href="https://example.com/a(b)">site</a></div>'
            f'<div><en-media hash="{digest}" type="image/png"/></div>'
            f'<div><en-media hash="{hashlib.md5(pdf).hexdigest()}" type="application/pdf"/></div>'
            '<div><en-media hash="00000000000000000000000000000000" type="image/png"/></div>'
            '<div><en-todo checked="true"/>done</div><div><en-todo/>open</div>'
            '<h2>Head</h2><ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol><li>a</li><li>b</li></ol>'
            '<table><tr><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></table>'
            '<en-crypt hint="h">SECRETCIPHER</en-crypt>'
        )
        extra = (
            "<tag>work</tag><tag>Ideas</tag><tag>work</tag>"
            "<note-attributes><source-url>https://example.com/src</source-url><author>x</author></note-attributes>"
            + resource(PNG, "image/png", "pic one.png") + resource(pdf, "application/pdf")
        )
        r = self.parse(enex(note("My note", body, extra), note("Second", "<div>plain</div>")))
        self.assertTrue(r["ok"], r)
        first, second = r["notes"]
        self.assertEqual(first["title"], "My note")
        self.assertTrue(first["titleManual"])
        self.assertEqual(first["tags"], ["work", "Ideas"])
        self.assertEqual(first["created_at"], "2024-01-02T03:04:05.000Z")
        self.assertEqual(first["updated_at"], "2024-02-03T04:05:06.000Z")
        self.assertEqual([a["name"] for a in first["attachments"]], ["pic one.png", "attachment-2.pdf"])
        self.assertEqual(base64.b64decode(first["attachments"][0]["b64"]), PNG)
        self.assertEqual(first["attachments"][0]["mime"], "image/png")
        self.assertEqual(r["attachmentCount"], 2)
        c = first["content"]
        self.assertIn("**Hello** *world* \\<b> [site](https://example.com/a%28b%29)", c)
        self.assertIn("![pic one.png](<pic one.png>)", c)
        self.assertIn("[attachment-2.pdf](attachment-2.pdf)", c)
        self.assertIn("[missing attachment]", c)
        self.assertIn("- [x] done\n- [ ] open", c)
        self.assertIn("## Head", c)
        self.assertIn("- one\n  - nested\n- two", c)
        self.assertIn("1. a\n2. b", c)
        self.assertIn("| x | y |\n| --- | --- |\n| 1 | 2 |", c)
        self.assertIn("[encrypted text not imported]", c)
        self.assertNotIn("SECRETCIPHER", c)
        self.assertTrue(c.endswith("Source: https://example.com/src"))
        self.assertEqual(first["editor"], "markdown")
        self.assertEqual(second["content"], "plain")
        self.assertEqual(second["attachments"], [])

    def test_all_tasks_become_checklist(self):
        r = self.parse(enex(note("t", '<div><en-todo checked="true"/>a</div><div><en-todo/>b</div>')))
        self.assertEqual(r["notes"][0]["editor"], "checklist")
        self.assertEqual(r["notes"][0]["content"], "- [x] a\n- [ ] b")

    def test_doctype_and_entities_refused(self):
        evernote_dtd = '<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd"'
        bombs = {
            "internal subset": enex(note("x", "<div>a</div>"), doctype='<!DOCTYPE en-export [<!ENTITY a "aaaa">]>'),
            "other system id": enex(note("x", "<div>a</div>"), doctype='<!DOCTYPE en-export SYSTEM "http://evil.example/x.dtd">'),
            "entity in enex": enex(note("&a;", "<div>a</div>"), doctype=evernote_dtd + ' [<!ENTITY a "b">]>'),
            "entity decl in enml cdata": enex(note("x", "<div>&a;</div>", doctype='<!DOCTYPE en-note [<!ENTITY a "lol">]>')),
            "doctype in enml cdata": enex(note("x", "<div>a</div>", doctype='<!DOCTYPE en-note SYSTEM "http://evil.example/e.dtd">')),
            "entity in escaped enml": ('<?xml version="1.0"?><en-export><note><title>x</title><content>'
                                       '&lt;!DOCTYPE en-note [&lt;!ENTITY a "b"&gt;]&gt;&lt;en-note&gt;&amp;a;&lt;/en-note&gt;</content></note></en-export>'),
        }
        for label, text in bombs.items():
            with self.subTest(label):
                r = self.parse(text)
                self.assertFalse(r["ok"], r)
                self.assertIn("Import refused", r["error"])
        # The same file without the hostile part still imports, so the refusal is caused by the declaration.
        self.assertTrue(self.parse(enex(note("x", "<div>a</div>")))["ok"])

    def test_malformed_and_foreign_xml_refused(self):
        self.assertFalse(self.parse("<en-export><note></en-export>")["ok"])
        self.assertIn("not an Evernote export", self.parse("<html><body/></html>")["error"])
        r = self.parse(enex(note("x", "<div>&nbsp;</div>")))
        self.assertTrue(r["ok"])
        self.assertEqual(r["notes"], [])
        self.assertEqual(r["skipped"][0]["reason"], "content is not valid ENML")

    def test_script_handlers_and_javascript_urls_removed(self):
        body = (
            '<div>before<script>alert("XSS-SCRIPT")</script>after</div>'
            '<div><a href="javascript:alert(1)" onclick="alert(2)">js link</a></div>'
            '<div><a href=" JaVaScRiPt:alert(3)">spaced</a> <a href="java&#9;script:alert(4)">tab</a> <a href="data:text/html,x">data</a></div>'
            '<div><a href="vbscript:x">vb</a> <a href="file:///etc/passwd">file</a> <a href="mailto:a@b.c">mail</a></div>'
            '<div><img src="http://127.0.0.1:9/track.png" onerror="alert(5)"/><span onmouseover="alert(6)">span</span></div>'
            '<style>body{background:url(http://127.0.0.1:9/css)}</style>'
            '<iframe src="http://127.0.0.1:9/frame"></iframe><div style="x" class="y">styled</div>'
        )
        r = self.parse(enex(note("xss", body)))
        self.assertTrue(r["ok"], r)
        c = r["notes"][0]["content"]
        for bad in ("<script", "XSS-SCRIPT", "javascript", "JaVaScRiPt", "onerror", "onclick", "onmouseover", "vbscript",
                    "data:text", "file:", "<img", "<a ", "<iframe", "<style", "background", "127.0.0.1", "style="):
            self.assertNotIn(bad, c)
        for kept in ("js link", "spaced", "tab", "vb", "span", "styled", "[mail](mailto:a@b.c)", "beforeafter"):
            self.assertIn(kept, c)
        self.assertNotIn("[js link]", c)

    def test_no_network_request_while_parsing(self):
        self.requests.clear()
        body = ('<div><img src="http://127.0.0.1:9/a.png"/><a href="http://127.0.0.1:9/l">l</a>'
                '<en-media hash="abc" type="image/png"/></div>')
        r = self.parse(enex(note("net", body, resource(PNG, "image/png", "p.png"))))
        self.assertTrue(r["ok"], r)
        self.page.wait_for_timeout(200)
        self.assertEqual([u for u in self.requests if not u.startswith(("about:", "data:"))], [])

    def test_limits(self):
        many = "".join(resource(b"x" + bytes([i]), "text/plain", f"f{i}.txt") for i in range(101))
        r = self.parse(enex(note("many", "<div>a</div>", many)))
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(r["notes"][0]["attachments"]), 100)
        self.assertIn("over the limit of 100", r["skipped"][0]["reason"])
        too_big = self.page.evaluate("""async () => {
          try { await NotesEnexImport.parse([{ name: 'big.enex', bytes: new Uint8Array(256 * 1024 * 1024 + 1) }]); return 'accepted'; }
          catch (err) { return err.message; }
        }""")
        self.assertIn("larger than 256 MiB", too_big)
        deep = "<div>" * 70 + "x" + "</div>" * 70
        r = self.parse(enex(note("deep", deep)))
        self.assertFalse(r["ok"])
        self.assertIn("nested deeper", r["error"])
        r = self.parse("x", name="notes.txt")
        self.assertTrue(r["ok"])
        self.assertEqual(r["skipped"][0]["reason"], "not an .enex file")

    def test_md5_matches_reference(self):
        for size in (0, 1, 55, 56, 63, 64, 65, 119, 120, 1000):
            data = bytes((i * 7 + 3) % 256 for i in range(size))
            got = self.page.evaluate("(b) => NotesEnexImport.md5Hex(new Uint8Array(b))", list(data))
            self.assertEqual(got, hashlib.md5(data).hexdigest(), size)


if __name__ == "__main__":
    unittest.main()
