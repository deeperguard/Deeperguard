"""The push reminders toggle must point at a notice that says what the server sees."""
from __future__ import annotations

import unittest
from html.parser import HTMLParser
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / "app" / "templates" / "app.html"

# Claims that the server is fully blind to reminders. They are false: the server
# learns each reminder's ID, due time and channel.
BLINDNESS_CLAIMS = ("server knows nothing", "server sees nothing", "server cannot see",
                    "server can’t see", "server weet niets")


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
        for needed in ("Off by default", "push address", "random ID", "exact time it is due",
                       "start time",
                       "never learns event titles", "Google, Apple or Mozilla",
                       "removes its push address", "backups and logs"):
            self.assertIn(needed, notice)
        self.assertNotIn("15-minute window", notice)
        for claim in BLINDNESS_CLAIMS:
            self.assertNotIn(claim, notice.lower())

    def test_visibility_notice_states_window_for_email_and_exact_time_for_push(self):
        c = _Collect()
        c.feed(TEMPLATE.read_text(encoding="utf-8"))
        notice = " ".join(c.text["agenda-reminder-visibility"].split())
        self.assertIn("never its title, location or notes", notice)
        self.assertIn("Email reminders show only a 15-minute window", notice)
        self.assertIn("Push reminders show the exact time", notice)
        self.assertIn("only work while Deeperguard is open", notice)
        for claim in BLINDNESS_CLAIMS:
            self.assertNotIn(claim, notice.lower())


if __name__ == "__main__":
    unittest.main()
