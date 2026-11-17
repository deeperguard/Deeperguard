"""The push reminders toggle must point at a notice that says what the server sees."""
from __future__ import annotations

import unittest
from html.parser import HTMLParser
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / "app" / "templates" / "app.html"


class _Collect(HTMLParser):
    def __init__(self):
        super().__init__()
        self.attrs = {}
        self.text = {}
        self._open = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get("id"):
            self.attrs[a["id"]] = a
            self._open = a["id"] if tag == "p" else None

    def handle_endtag(self, tag):
        if tag == "p":
            self._open = None

    def handle_data(self, data):
        if self._open:
            self.text[self._open] = self.text.get(self._open, "") + data


class PushToggleNoticeTest(unittest.TestCase):
    def test_toggle_is_described_by_a_server_visibility_notice(self):
        c = _Collect()
        c.feed(TEMPLATE.read_text(encoding="utf-8"))
        toggle = c.attrs["agenda-reminder-push"]
        self.assertEqual(toggle.get("type"), "checkbox")
        target = toggle["aria-describedby"]
        self.assertIn(target, c.attrs)
        notice = " ".join(c.text[target].split())
        for needed in ("Off by default", "push address", "random ID", "15-minute window",
                       "up to 15 minutes early",
                       "never learns event titles", "Google, Apple or Mozilla",
                       "removes its push address", "backups and logs"):
            self.assertIn(needed, notice)


if __name__ == "__main__":
    unittest.main()
