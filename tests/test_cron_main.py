"""warning_cron.main runs warnings, agenda reminders and push windows, isolated and log-safe."""
import importlib
import logging
import os
import sys
import tempfile
import unittest
import time
import uuid
from pathlib import Path
from unittest.mock import patch

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

ADDR = "cron-secret-addr@e2e.invalid"
TITLE = "Secret Title 4711"
MODULES = {"app", "db", "config", "mailer", "warning_cron", "agenda_reminder_cron", "plans", "email_verify"}


T0 = (int(time.time() // 900) + 2) * 900.0  # a future 15-minute window


class CronMainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("s", encoding="utf-8")
        for name in list(sys.modules):
            if name in MODULES or name.startswith("app."):
                sys.modules.pop(name, None)
        self.db = importlib.import_module("db")
        self.wc = importlib.import_module("warning_cron")
        self.arc = importlib.import_module("agenda_reminder_cron")

    def tearDown(self):
        self.tmp.cleanup()

    def _user(self, verified=True, plan="pro"):
        uid = self.db.create_user(f"{uuid.uuid4().hex[:6]}{ADDR}", "h", "s")
        self.db.update_user_plan(uid, plan)
        if verified:
            self.db.mark_email_verified(uid)
        else:
            self.db.connection().execute("UPDATE users SET email_verified = 0 WHERE id = ?", (uid,))
            self.db.connection().commit()
        return uid

    def _remind(self, uid, fire_at):
        self.db.sync_agenda_reminders(
            uid, [dict(id=str(uuid.uuid4()), fire_at=fire_at, channel="email", local_time_label="")], []
        )

    def _steps(self, w=None, a=None, p=None):
        def mk(tag, override):
            return override if override is not None else (lambda: self.calls.append(tag) or 0)

        self.calls = []
        return (
            patch.object(self.wc, "run_warnings", mk("w", w)),
            patch.object(self.arc, "run_agenda_reminders", mk("a", a)),
            patch.object(self.arc, "run_push_windows", mk("p", p)),
        )

    def test_order_and_exit_code(self):
        p1, p2, p3 = self._steps()
        with p1, p2, p3:
            self.assertEqual(self.wc.main(), 0)
        self.assertEqual(self.calls, ["w", "a", "p"])

    def test_agenda_failure_does_not_stop_others(self):
        p1, p2, p3 = self._steps(a=self._raiser())
        with p1, p2, p3:
            self.assertEqual(self.wc.main(), 1)
        self.assertEqual(self.calls, ["w", "p"])

    def test_warnings_failure_does_not_stop_others(self):
        p1, p2, p3 = self._steps(w=self._raiser())
        with p1, p2, p3:
            self.assertEqual(self.wc.main(), 1)
        self.assertEqual(self.calls, ["a", "p"])

    @staticmethod
    def _raiser():
        def boom():
            raise RuntimeError(f"{ADDR} {TITLE}")

        return boom

    def test_due_reminder_sent_exactly_once_over_two_runs(self):
        uid = self._user()
        self._remind(uid, T0)
        with patch.object(self.arc, "send_plain_email") as mail:
            first = self.arc.run_agenda_reminders(T0 + 60)
            second = self.arc.run_agenda_reminders(T0 + 120)
        self.assertEqual((first, second), (1, 0))
        self.assertEqual(mail.call_count, 1)

    def test_unverified_or_free_gets_no_mail(self):
        self._remind(self._user(verified=False), T0)
        self._remind(self._user(plan="free"), T0)
        with patch.object(self.arc, "send_plain_email") as mail:
            self.arc.run_agenda_reminders(T0 + 60)
        mail.assert_not_called()

    def test_too_late_not_sent(self):
        self._remind(self._user(), T0)
        with patch.object(self.arc, "send_plain_email") as mail:
            self.arc.run_agenda_reminders(T0 + self.arc.max_late_sec() + 60)
        mail.assert_not_called()

    def test_logs_contain_no_address_or_title(self):
        self._remind(self._user(), T0)
        with self.assertLogs(level="DEBUG") as cm:
            logging.getLogger("deeperguard.warnings").info("start")
            with patch.object(self.arc, "send_plain_email", side_effect=RuntimeError(f"{ADDR} {TITLE}")):
                self.arc.run_agenda_reminders(T0 + 60)
            p1, p2, p3 = self._steps(w=self._raiser())
            with p1, p2, p3:
                self.wc.main()
        text = "\n".join(cm.output)
        self.assertNotIn("e2e.invalid", text)
        self.assertNotIn(TITLE, text)

    def test_smtp_timeout_is_explicit(self):
        import mailer

        self.assertEqual(mailer.smtp_timeout_sec(), 20.0)
        with patch.dict(os.environ, {"NOTES_SMTP_TIMEOUT_SEC": "7"}):
            self.assertEqual(mailer.smtp_timeout_sec(), 7.0)
        with patch("mailer.smtplib.SMTP") as smtp:
            mailer.send_plain_email("a@b.invalid", "s", "b")
        self.assertEqual(smtp.call_args.kwargs["timeout"], 20.0)


if __name__ == "__main__":
    unittest.main()
